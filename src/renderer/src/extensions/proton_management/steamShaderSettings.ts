import { execFile } from "child_process";
import { randomUUID } from "crypto";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";

import { SHADER_CACHE_SOURCE } from "./shaderCacheRunner";
const execFileAsync = promisify(execFile);

interface ICDPTarget {
  title: string;
  webSocketDebuggerUrl?: string;
}

interface ICDPResponse {
  id?: number;
  result?: {
    exceptionDetails?: { exception?: { description?: string }; text?: string };
    result?: { value?: unknown };
  };
}

const STEAM_CDP_URL = "http://127.0.0.1:8080/json/list";

export const SHADER_CACHE_WRAPPER = path.join(
  os.homedir(),
  ".local",
  "share",
  "vortex",
  "bin",
  "vortex-shader-cache-run",
);
export const GAME_LAUNCH_WRAPPER = path.join(
  os.homedir(),
  ".local",
  "share",
  "vortex",
  "bin",
  "vortex-game-run",
);

const GAME_LAUNCH_SOURCE = `#!/usr/bin/env python3
import os
from pathlib import Path
import sys

if sys.argv[1:] == ["--check"]:
    if sys.version_info < (3, 10):
        raise SystemExit("Python 3.10 or newer is required")
    raise SystemExit(0)
if len(sys.argv) < 3:
    raise SystemExit("usage: vortex-game-run <loader.exe> <command> [args...]")
loader = sys.argv[1]
command = sys.argv[2:]
for index in range(len(command)):
    if Path(command[index]).suffix.lower() == ".exe":
        command[index] = loader
        break
else:
    raise SystemExit("Steam command did not contain a Windows executable")
os.execvp(command[0], command)
`;

export async function ensureGameLaunchWrapper(wrapperPath = GAME_LAUNCH_WRAPPER): Promise<void> {
  await writeManagedFile(wrapperPath, GAME_LAUNCH_SOURCE, 0o755);
}

async function checkWrapper(wrapperPath: string, args: string[]): Promise<void> {
  try {
    await execFileAsync(wrapperPath, args, { timeout: 15_000 });
    if (process.env.IS_FLATPAK === "true") {
      // The packaged cwd (/app/main) exists only inside Flatpak, not on the Steam host.
      await execFileAsync("flatpak-spawn", ["--host", wrapperPath, ...args], {
        cwd: "/",
        timeout: 15_000,
      });
    }
  } catch (err) {
    throw new Error(
      "The Proton launcher check failed. Install Python 3.10 or newer in the launch environment and on the Steam host, and check the configured cache paths.",
      { cause: err },
    );
  }
}

export async function checkShaderCacheWrapper(
  appId: string,
  wrapperPath = SHADER_CACHE_WRAPPER,
): Promise<void> {
  if (!/^\d+$/.test(appId)) throw new Error("Invalid Steam AppID");
  await checkWrapper(wrapperPath, ["--check", appId]);
}

export async function checkGameLaunchWrapper(wrapperPath = GAME_LAUNCH_WRAPPER): Promise<void> {
  await checkWrapper(wrapperPath, ["--check"]);
}

async function writeManagedFile(target: string, source: string, mode: number): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await refuseWrapperSymlink(target);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, source, { mode, flag: "wx" });
    await fs.chmod(temporary, mode);
    await fs.rename(temporary, target);
  } finally {
    await fs.unlink(temporary).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOENT") throw err;
    });
  }
}

async function refuseWrapperSymlink(wrapperPath: string): Promise<void> {
  try {
    if ((await fs.lstat(wrapperPath)).isSymbolicLink())
      throw new Error("Refusing a symbolic-link launcher");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

export async function ensureShaderCacheWrapper(wrapperPath = SHADER_CACHE_WRAPPER): Promise<void> {
  await writeManagedFile(wrapperPath, SHADER_CACHE_SOURCE, 0o755);
}

export async function configureShaderCache(
  appId: string,
  sourceRoots: string[],
  wrapperPath = SHADER_CACHE_WRAPPER,
  privateRoot = path.join(os.homedir(), ".cache", "vortex", "shadercache"),
): Promise<void> {
  if (!/^\d+$/.test(appId)) throw new Error("Invalid Steam AppID");
  const directory = path.join(path.dirname(wrapperPath), "shader-cache-settings");
  await fs.mkdir(directory, { recursive: true });
  const target = path.join(directory, `${appId}.json`);
  await writeManagedFile(
    target,
    JSON.stringify({ privateRoot, sourceRoots: sourceRoots.map((root) => path.join(root, appId)) }),
    0o600,
  );
}

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function gameLaunchInvocation(loaderPath: string, wrapperPath: string): string {
  return `${quoteShell(wrapperPath)} ${quoteShell(loaderPath)} `;
}

export function enableDefaultToolRedirect(
  launchOptions: string,
  loaderPath: string,
  wrapperPath: string,
): string {
  const invocation = gameLaunchInvocation(loaderPath, wrapperPath);
  if (launchOptions.includes(invocation)) return launchOptions;
  const original = disableDefaultToolRedirect(launchOptions, wrapperPath);
  return original.includes("%command%")
    ? original.replace("%command%", `${invocation}%command%`)
    : `${invocation}%command% ${original}`.trim();
}

/** Remove only the exact managed wrapper and its quoted loader before Steam's placeholder. */
export function disableDefaultToolRedirect(launchOptions: string, wrapperPath: string): string {
  const prefix = `${quoteShell(wrapperPath)} `;
  const start = launchOptions.indexOf(prefix);
  if (start < 0) return launchOptions;
  let cursor = start + prefix.length;
  if (launchOptions[cursor++] !== "'") throw new Error("Unrecognised managed Steam launcher");
  while (cursor < launchOptions.length) {
    if (launchOptions.startsWith("'\\''", cursor)) cursor += 4;
    else if (launchOptions[cursor++] === "'") break;
  }
  if (!launchOptions.slice(cursor).startsWith(" %command%"))
    throw new Error("Unrecognised managed Steam launcher");
  return launchOptions.slice(0, start) + launchOptions.slice(cursor + 1);
}

async function sharedContextUrl(): Promise<string> {
  const response = await fetch(STEAM_CDP_URL, { signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error(`Steam settings endpoint returned ${response.status}`);
  const targets = (await response.json()) as ICDPTarget[];
  const target = targets.find((item) => item.title === "SharedJSContext");
  if (target?.webSocketDebuggerUrl === undefined) {
    throw new Error("Steam settings service is unavailable");
  }
  return target.webSocketDebuggerUrl;
}

export interface ISteamSettingsTarget {
  gamePath: string;
  steamPath: string;
  assertCurrent?: () => void;
}

// RequestAppDetails returns an unobserved cached snapshot when the Steam library
// page has no active subscription. A native one-shot subscription obtains the
// current settings, including changes made through SetAppLaunchOptions.
function freshSteamDetails(appId: string): string {
  return `new Promise((resolve, reject) => {
    let registration;
    let completed = false;
    const timeout = setTimeout(() => {
      completed = true;
      registration?.unregister();
      reject(new Error("Timed out reading current Steam app details"));
    }, 5000);
    try {
      registration = SteamClient.Apps.RegisterForAppDetails(${JSON.stringify(Number(appId))}, (details) => {
        if (completed) return;
        completed = true;
        clearTimeout(timeout);
        registration?.unregister();
        resolve(details);
      });
      if (completed) registration?.unregister();
    } catch (error) {
      completed = true;
      clearTimeout(timeout);
      reject(error);
    }
  })`;
}

async function evaluateSteam<T>(
  expression: string,
  appId: string,
  expected: ISteamSettingsTarget,
): Promise<T> {
  const witnessExpression = `(async () => {
    const details = await ${freshSteamDetails(appId)};
    const folders = await SteamClient.InstallFolder.GetInstallFolders();
    const roots = folders.filter(folder => folder.nFolderIndex === 0);
    if (roots.length !== 1) throw new Error("Steam client installation is unavailable");
    return { gamePath: details?.strInstallFolder, steamPath: roots[0].strFolderPath };
  })()`;
  const socket = new WebSocket(await sharedContextUrl());
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let phase = 1;
    const send = (id: number, source: string) =>
      socket.send(
        JSON.stringify({
          id,
          method: "Runtime.evaluate",
          params: { awaitPromise: true, expression: source, returnByValue: true },
        }),
      );
    const finish = (error?: Error, value?: T) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      socket.close();
      if (error !== undefined) reject(error);
      else resolve(value as T);
    };
    const timeout = window.setTimeout(() => {
      finish(new Error("Timed out waiting for Steam settings"));
    }, 10_000);
    socket.onerror = () => finish(new Error("Could not connect to Steam settings"));
    socket.onclose = () => finish(new Error("Steam settings connection closed before responding"));
    socket.onopen = () => {
      try {
        send(1, witnessExpression);
      } catch {
        finish(new Error("Could not send Steam settings request"));
      }
    };
    const handleMessage = async (event: MessageEvent) => {
      let message: ICDPResponse;
      try {
        message = JSON.parse(String(event.data)) as ICDPResponse;
      } catch {
        finish(new Error("Steam settings returned an invalid response"));
        return;
      }
      if (message === null || typeof message !== "object") {
        finish(new Error("Steam settings returned an invalid response"));
        return;
      }
      if (settled || message.id !== phase) return;
      const exception = message.result?.exceptionDetails;
      if (exception !== undefined) {
        finish(
          new Error(exception.exception?.description ?? exception.text ?? "Steam setting failed"),
        );
      } else if (message.result?.result === undefined) {
        finish(new Error("Steam settings returned no result"));
      } else if (phase === 1) {
        const witness = message.result.result.value as
          | { gamePath?: unknown; steamPath?: unknown }
          | undefined;
        if (
          typeof witness?.gamePath !== "string" ||
          typeof witness?.steamPath !== "string" ||
          !path.isAbsolute(witness.gamePath) ||
          !path.isAbsolute(witness.steamPath) ||
          !path.isAbsolute(expected.gamePath) ||
          !path.isAbsolute(expected.steamPath)
        )
          throw new Error(
            "Steam installation identity is unavailable. Start the matching Steam client and refresh Games.",
          );
        const [actualGame, expectedGame, actualSteam, expectedSteam] = await Promise.all([
          fs.realpath(witness.gamePath),
          fs.realpath(expected.gamePath),
          fs.realpath(witness.steamPath),
          fs.realpath(expected.steamPath),
        ]);
        if (actualGame !== expectedGame || actualSteam !== expectedSteam)
          throw new Error(
            "Steam settings belong to another installation. Start the matching Steam client and refresh Games.",
          );
        if (settled) return;
        expected.assertCurrent?.();
        phase = 2;
        // Recheck on the same connection immediately before executing the operation.
        send(
          2,
          `(async () => {
          const current = await (${witnessExpression});
          if (current.gamePath !== ${JSON.stringify(witness.gamePath)} || current.steamPath !== ${JSON.stringify(witness.steamPath)}) throw new Error("Steam installation changed before applying its settings");
          return await (${expression});
        })()`,
        );
      } else {
        finish(undefined, message.result.result.value as T);
      }
    };
    socket.onmessage = (event) => {
      void handleMessage(event).catch((error) =>
        finish(error instanceof Error ? error : new Error("Steam settings request failed")),
      );
    };
  });
}

export async function getSteamLaunchOptions(
  appId: string,
  expected: ISteamSettingsTarget,
): Promise<string> {
  if (!/^\d+$/.test(appId)) throw new Error("Invalid Steam AppID");
  const result = await evaluateSteam<unknown>(
    `(async () => {
      const details = await ${freshSteamDetails(appId)};
      if (typeof details?.strLaunchOptions !== "string") throw new Error("Steam launch options are unavailable");
      return details.strLaunchOptions;
    })()`,
    appId,
    expected,
  );
  if (typeof result !== "string") throw new Error("Steam returned invalid launch options");
  return result;
}

export async function setSteamLaunchOptions(
  appId: string,
  launchOptions: string,
  expected: ISteamSettingsTarget,
): Promise<string> {
  if (!/^\d+$/.test(appId)) throw new Error("Invalid Steam AppID");
  return evaluateSteam<string>(
    `(async () => {
    const accepted = await SteamClient.Apps.SetAppLaunchOptions(${JSON.stringify(Number(appId))}, ${JSON.stringify(launchOptions)});
    if (accepted === false) throw new Error("Steam refused the launch options");
    return ${JSON.stringify(launchOptions)};
  })()`,
    appId,
    expected,
  );
}

export async function setSteamCompatTool(
  appId: string,
  toolName: string,
  expected: ISteamSettingsTarget,
): Promise<void> {
  if (!/^\d+$/.test(appId)) throw new Error("Invalid Steam AppID");
  if (!/^[A-Za-z0-9_.+ -]+$/.test(toolName)) throw new Error("Invalid Proton compatibility tool");
  await evaluateSteam<void>(
    `(async () => { const accepted = await SteamClient.Apps.SpecifyCompatTool(${JSON.stringify(Number(appId))}, ${JSON.stringify(toolName)}); if (accepted === false) throw new Error("Steam refused the Proton version"); })()`,
    appId,
    expected,
  );
}

export function shaderCacheInvocation(appId: string, wrapperPath: string): string {
  if (!/^\d+$/.test(appId)) throw new Error("Invalid Steam AppID");
  const quoted = `'${wrapperPath.replace(/'/g, `'\\''`)}'`;
  return `${quoted} ${appId} `;
}

export function enableShaderCacheRedirect(
  launchOptions: string,
  appId: string,
  wrapperPath: string,
): string {
  const invocation = shaderCacheInvocation(appId, wrapperPath);
  if (launchOptions.includes(invocation)) return launchOptions;
  return launchOptions.includes("%command%")
    ? launchOptions.replace("%command%", `${invocation}%command%`)
    : `${invocation}%command% ${launchOptions}`.trim();
}

export function disableShaderCacheRedirect(
  launchOptions: string,
  appId: string,
  wrapperPath: string,
): string {
  return launchOptions.replace(shaderCacheInvocation(appId, wrapperPath), "");
}
