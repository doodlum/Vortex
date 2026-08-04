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
