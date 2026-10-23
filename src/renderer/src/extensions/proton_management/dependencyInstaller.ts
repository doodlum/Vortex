import { unknownToError } from "@vortex/shared";
import { ProcessCanceled } from "@vortex/shared/errors";

import type { IExtensionApi } from "@/types/IExtensionContext";
import type { IDependencyTarget } from "@/util/linux/protonMetadata";

import { publishProtonSetupStatus } from "./setupStatus";

const PROTONTRICKS_APP_ID = "com.github.Matoking.protontricks";
const RECIPES = new Set([
  "vcrun2010",
  "vcrun2012",
  "vcrun2013",
  "vcrun2022",
  "d3dcompiler_43",
  "d3dcompiler_47",
  "d3dx9",
  "xinput",
  "xact",
]);
const pending = new Map<string, Promise<void>>();

/** Runs inside Protontricks' final environment, including its nested runtime sandbox. */
export const DEPENDENCY_COMMAND_PYTHON = String.raw`import json, os
from pathlib import Path
target = json.loads(os.environ["VORTEX_DEPENDENCY_TARGET"])
for actual, expected in [("PROTON_PATH", "protonPath"), ("STEAM_APP_PATH", "gamePath")]:
    if Path(os.environ[actual]).resolve(strict=True) != Path(target[expected]).resolve(strict=True):
        raise RuntimeError("Protontricks selected a different " + actual + "; refresh Steam libraries and retry")
if Path(os.environ["WINEPREFIX"]).resolve(strict=True) != (Path(target["compatDataPath"]) / "pfx").resolve(strict=True):
    raise RuntimeError("Protontricks selected a different Windows prefix; refresh Steam libraries and retry")
if target.get("runtimePath") and Path(os.environ["STEAM_RUNTIME_PATH"]).resolve(strict=True) != Path(target["runtimePath"]).resolve(strict=True):
    raise RuntimeError("Protontricks selected a different Steam Runtime; refresh Steam libraries and retry")
arguments = json.loads(os.environ["VORTEX_DEPENDENCY_RECIPES"])
winetricks = os.environ["WINETRICKS"]
os.execvp(winetricks, [winetricks, *arguments])
`;
const DEPENDENCY_COMMAND = `python3 -c '${DEPENDENCY_COMMAND_PYTHON.replaceAll("'", "'\\''")}'`;

export type DependencyProgress = (progress: number, message: string) => void;
export interface IDependencyInstallOptions {
  assertCurrent?: () => void;
  force?: boolean;
  target?: IDependencyTarget;
}

// Helper downloads can be large, but a Wine run that stops responding never exits on its own,
// so every step is capped. A stuck step would otherwise hold the coordinator, and with it every
// later launch, behind a progress notification that can't be dismissed. The idea of capping
// in-prefix installers comes from Amethyst Mod Manager (GPL-3.0), src/Utils/wine/protontricks.py.
export const HELPER_TIMEOUT_MS = 30 * 60 * 1000;
export const RECIPE_TIMEOUT_MS = 20 * 60 * 1000;
const KILL_GRACE_MS = 10 * 1000;

function stopProcess(pid: number | undefined) {
  if (pid === undefined) return;
  const signal = (name: NodeJS.Signals) => {
    try {
      process.kill(pid, name);
      return true;
    } catch {
      return false;
    }
  };
  // `flatpak run` and `flatpak-spawn` pass the signal on and take their sandboxes down with them.
  if (signal("SIGTERM")) setTimeout(() => signal("SIGKILL"), KILL_GRACE_MS).unref?.();
}

function runHost(
  api: IExtensionApi,
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<void> {
  let pid: number | undefined;
  const run = api.runExecutable(
    process.env.IS_FLATPAK === "true" ? "flatpak-spawn" : command,
    process.env.IS_FLATPAK === "true" ? ["--host", command, ...args] : args,
    {
      cwd: "/",
      expectSuccess: true,
      shell: false,
      onSpawned: (spawned) => {
        pid = spawned;
      },
    },
  );
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      stopProcess(pid);
      reject(
        new Error(
          `${command} ${args[0] ?? ""} stopped responding and was ended after ${Math.round(timeoutMs / 60000)} minutes`,
        ),
      );
    }, timeoutMs);
    run.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function installDependencies(
  api: IExtensionApi,
  appId: string,
  verbs: string[],
  onProgress?: DependencyProgress,
  options: IDependencyInstallOptions = {},
): Promise<void> {
  if (!/^\d+$/.test(appId)) throw new Error("Invalid Steam AppID");
  if (verbs.some((verb) => !RECIPES.has(verb)))
    throw new Error("Unsupported Windows dependency recipe");
  if (verbs.length === 0) return;
  if (options.target === undefined)
    throw new Error(
      "The exact Steam installation, Proton runtime and prefix are required for dependency installation",
    );
  const previous = pending.get(appId) ?? Promise.resolve();
  const operation = previous
    .catch(() => undefined)
    .then(() => install(api, appId, [...new Set(verbs)], onProgress, options));
  pending.set(appId, operation);
  try {
    await operation;
  } finally {
    if (pending.get(appId) === operation) pending.delete(appId);
  }
}

async function install(
  api: IExtensionApi,
  appId: string,
  verbs: string[],
  onProgress?: DependencyProgress,
  options: IDependencyInstallOptions = {},
): Promise<void> {
  const target = options.target;
  if (target === undefined) throw new Error("A verified dependency target is required");
  const check = () => options.assertCurrent?.();
  const run = (command: string, args: string[], timeoutMs = HELPER_TIMEOUT_MS) => {
    check();
    return runHost(api, command, args, timeoutMs);
  };
  const report = (progress: number, message: string) => {
    check();
    onProgress?.(progress, message);
    publishProtonSetupStatus({ appId, message, phase: "installing", progress });
  };
  try {
    report(5, "Checking Proton dependency support");
    const scope = await protontricksScope(run);
    // Winetricks recipes contain checksums for vendor redistributables. Vendors update those files,
    // so an old Protontricks can reject an authentic current installer and silently leave a prefix
    // without the dependency Vortex requested. Refresh the helper before relying on its result.
    report(20, "Installing or updating Protontricks");
    await run("flatpak", ["update", scope, "--noninteractive", "-y", PROTONTRICKS_APP_ID]);
    report(55, `Installing ${verbs.join(", ")}`);
    await run(
      "flatpak",
      [
        "run",
        scope,
        "--unset-env=WINE",
        "--unset-env=WINESERVER",
        "--unset-env=WINETRICKS",
        "--unset-env=STEAM_RUNTIME",
        ...target.readOnlyRoots.map((root) => `--filesystem=${root}:ro`),
        ...target.runtimeWritePaths.map((root) => `--filesystem=${root}:rw`),
        `--filesystem=${target.compatDataPath}:rw`,
        `--env=STEAM_DIR=${target.steamPath}`,
        `--env=STEAM_COMPAT_DATA_PATH=${target.compatDataPath}`,
        `--env=PROTON_VERSION=${target.protonName}`,
        `--env=VORTEX_DEPENDENCY_TARGET=${JSON.stringify(target)}`,
        `--env=VORTEX_DEPENDENCY_RECIPES=${JSON.stringify(["-q", ...(options.force ? ["--force"] : []), ...verbs])}`,
        PROTONTRICKS_APP_ID,
        "-c",
        DEPENDENCY_COMMAND,
        appId,
      ],
      RECIPE_TIMEOUT_MS,
    );
    report(90, "Windows components applied; checking installation records");
  } catch (err) {
    if (err instanceof ProcessCanceled) throw err;
    check();
    publishProtonSetupStatus({
      appId,
      message: unknownToError(err).message,
      phase: "error",
    });
    throw new Error(
      `${unknownToError(err).message}. Automatic Protontricks setup requires Flatpak and a Flathub remote on the Steam host.`,
      { cause: err },
    );
  }
}

/**
 * Where Protontricks is, or gets, installed: per user where possible, otherwise system-wide.
 * Image-based systems such as Bazzite configure Flathub as a system remote only, so a per-user
 * install fails there. The fallback order follows Amethyst Mod Manager (GPL-3.0),
 * src/Utils/flatpak/i386.py.
 */
async function protontricksScope(
  run: (command: string, args: string[]) => Promise<void>,
): Promise<"--user" | "--system"> {
  for (const scope of ["--user", "--system"] as const) {
    if (
      await run("flatpak", ["info", scope, PROTONTRICKS_APP_ID]).then(
        () => true,
        () => false,
      )
    )
      return scope;
  }
  const install = (scope: "--user" | "--system") =>
    run("flatpak", ["install", scope, "--noninteractive", "-y", "flathub", PROTONTRICKS_APP_ID]);
  try {
    await install("--user");
    return "--user";
  } catch (userError) {
    try {
      await install("--system");
      return "--system";
    } catch {
      throw userError;
    }
  }
}
