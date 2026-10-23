import { unknownToError } from "@vortex/shared";
import { ProcessCanceled } from "@vortex/shared/errors";
import type PromiseBB from "bluebird";

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

function runHost(api: IExtensionApi, command: string, args: string[]): PromiseBB<void> {
  return api.runExecutable(
    process.env.IS_FLATPAK === "true" ? "flatpak-spawn" : command,
    process.env.IS_FLATPAK === "true" ? ["--host", command, ...args] : args,
    { cwd: "/", expectSuccess: true, shell: false },
  );
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
  const run = (command: string, args: string[]) => {
    check();
    return runHost(api, command, args);
  };
  const report = (progress: number, message: string) => {
    check();
    onProgress?.(progress, message);
    publishProtonSetupStatus({ appId, message, phase: "installing", progress });
  };
  try {
    report(5, "Checking Proton dependency support");
    await run("flatpak", ["info", "--user", PROTONTRICKS_APP_ID]).catch(() =>
      run("flatpak", [
        "install",
        "--user",
        "--noninteractive",
        "-y",
        "flathub",
        PROTONTRICKS_APP_ID,
      ]),
    );
    // Winetricks recipes contain checksums for vendor redistributables. Vendors update those files,
    // so an old Protontricks can reject an authentic current installer and silently leave a prefix
    // without the dependency Vortex requested. Refresh the helper before relying on its result.
    report(20, "Installing or updating Protontricks");
    await run("flatpak", ["update", "--user", "--noninteractive", "-y", PROTONTRICKS_APP_ID]);
    report(55, `Installing ${verbs.join(", ")}`);
    await run("flatpak", [
      "run",
      "--user",
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
    ]);
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
      `${unknownToError(err).message}. Automatic Protontricks setup requires Flatpak and the Flathub user remote on the Steam host.`,
      { cause: err },
    );
  }
}
