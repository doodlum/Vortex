import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

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

if len(sys.argv) < 3:
    raise SystemExit("usage: vortex-game-run <loader.exe> <command> [args...]")
loader = sys.argv[1]
command = sys.argv[2:]
for index in range(len(command) - 1, -1, -1):
    if Path(command[index]).suffix.lower() == ".exe":
        command[index] = loader
        break
else:
    raise SystemExit("Steam command did not contain a Windows executable")
os.execvp(command[0], command)
`;

export async function ensureGameLaunchWrapper(wrapperPath = GAME_LAUNCH_WRAPPER): Promise<void> {
  await fs.mkdir(path.dirname(wrapperPath), { recursive: true });
  await fs.writeFile(wrapperPath, GAME_LAUNCH_SOURCE, { mode: 0o755 });
  await fs.chmod(wrapperPath, 0o755);
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
  return launchOptions.includes("%command%")
    ? launchOptions.replace("%command%", `${invocation}%command%`)
    : `${invocation}%command% ${launchOptions}`.trim();
}

async function sharedContextUrl(): Promise<string> {
  const response = await fetch(STEAM_CDP_URL);
  if (!response.ok) throw new Error(`Steam settings endpoint returned ${response.status}`);
  const targets = (await response.json()) as ICDPTarget[];
  const target = targets.find((item) => item.title === "SharedJSContext");
  if (target?.webSocketDebuggerUrl === undefined) {
    throw new Error("Steam settings service is unavailable");
  }
  return target.webSocketDebuggerUrl;
}

async function evaluateSteam<T>(expression: string): Promise<T> {
  const socket = new WebSocket(await sharedContextUrl());
  return new Promise<T>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      socket.close();
      reject(new Error("Timed out waiting for Steam settings"));
    }, 10_000);
    socket.onerror = () => {
      window.clearTimeout(timeout);
      reject(new Error("Could not connect to Steam settings"));
    };
    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: { awaitPromise: true, expression, returnByValue: true },
        }),
      );
    };
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as ICDPResponse;
      if (message.id !== 1) return;
      window.clearTimeout(timeout);
      socket.close();
      const exception = message.result?.exceptionDetails;
      if (exception !== undefined) {
        reject(
          new Error(exception.exception?.description ?? exception.text ?? "Steam setting failed"),
        );
      } else {
        resolve(message.result?.result?.value as T);
      }
    };
  });
}

export async function getSteamLaunchOptions(appId: string): Promise<string> {
  if (!/^\d+$/.test(appId)) throw new Error("Invalid Steam AppID");
  return evaluateSteam<string>(
    `String(appDetailsStore.GetAppDetails(${JSON.stringify(Number(appId))})?.strLaunchOptions ?? "")`,
  );
}

export async function setSteamLaunchOptions(appId: string, launchOptions: string): Promise<string> {
  if (!/^\d+$/.test(appId)) throw new Error("Invalid Steam AppID");
  return evaluateSteam<string>(`(async () => {
    await SteamClient.Apps.SetAppLaunchOptions(${JSON.stringify(Number(appId))}, ${JSON.stringify(launchOptions)});
    return ${JSON.stringify(launchOptions)};
  })()`);
}

export async function setSteamCompatTool(appId: string, toolName: string): Promise<void> {
  if (!/^\d+$/.test(appId)) throw new Error("Invalid Steam AppID");
  if (!/^[A-Za-z0-9_.+ -]+$/.test(toolName)) throw new Error("Invalid Proton compatibility tool");
  await evaluateSteam<void>(
    `SteamClient.Apps.SpecifyCompatTool(${JSON.stringify(Number(appId))}, ${JSON.stringify(toolName)})`,
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
