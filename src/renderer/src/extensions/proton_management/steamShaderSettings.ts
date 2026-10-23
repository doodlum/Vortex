import { execFile } from "child_process";
import { randomUUID } from "crypto";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";

import { SHADER_CACHE_SOURCE } from "./shaderCacheRunner";
const execFileAsync = promisify(execFile);

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

/**
 * Remove the loader redirect that earlier Vortex builds added to Steam's launch options, so that
 * Vortex's direct launches replay only the user's own options. Only the exact managed wrapper and
 * its quoted loader before Steam's placeholder are removed.
 */
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

export function shaderCacheInvocation(appId: string, wrapperPath: string): string {
  if (!/^\d+$/.test(appId)) throw new Error("Invalid Steam AppID");
  const quoted = `'${wrapperPath.replace(/'/g, `'\\''`)}'`;
  return `${quoted} ${appId} `;
}

/** Remove the shader-cache redirect that earlier Vortex builds added to Steam's launch options. */
export function disableShaderCacheRedirect(
  launchOptions: string,
  appId: string,
  wrapperPath: string,
): string {
  return launchOptions.replace(shaderCacheInvocation(appId, wrapperPath), "");
}
