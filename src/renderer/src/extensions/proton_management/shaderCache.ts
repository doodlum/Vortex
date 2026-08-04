import { execFile } from "child_process";
import type { Dirent } from "fs";
import * as fs from "fs/promises";
import * as path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export interface IModShaderCacheInfo {
  bytes: number;
  files: number;
  lastModified?: number;
}

export interface IPrivateShaderCacheInfo {
  privatePath: string;
  sourcePath?: string;
  seededAt?: number;
  totalBytes: number;
  totalFiles: number;
}

const EMPTY: IModShaderCacheInfo = { bytes: 0, files: 0 };

async function filesBelow(root: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(root, entry.name);
      if (entry.isDirectory()) return filesBelow(fullPath);
      // Never follow links out of the per-AppID shader directory.
      return entry.isFile() ? [fullPath] : [];
    }),
  );
  return nested.flat();
}

export async function inspectPrivateShaderCache(
  privateShaderRoot: string,
  appId: string,
): Promise<IPrivateShaderCacheInfo> {
  const privatePath = path.join(privateShaderRoot, appId);
  const files = await filesBelow(privatePath);
  const stats = await Promise.all(files.map((file) => fs.stat(file).catch(() => undefined)));
  const totals = stats.reduce(
    (result, stat) => {
      if (stat !== undefined) {
        result.totalFiles += 1;
        result.totalBytes += stat.size;
      }
      return result;
    },
    { totalBytes: 0, totalFiles: 0 },
  );
  try {
    const markerPath = path.join(privatePath, ".vortex-steam-source.json");
    const [marker, markerStat] = await Promise.all([
      fs.readFile(markerPath, "utf8").then((value) => JSON.parse(value)),
      fs.stat(markerPath),
    ]);
    return {
      ...totals,
      privatePath,
      seededAt: markerStat.mtimeMs,
      sourcePath: typeof marker.source === "string" ? marker.source : undefined,
    };
  } catch {
    return { ...totals, privatePath };
  }
}

/**
 * Files produced from the currently deployed game/mod shaders. Steam-owned downloaded and
 * precompiled databases deliberately use different names and are excluded.
 */
export async function modShaderCacheFiles(shaderRoot: string, appId: string): Promise<string[]> {
  if (!/^\d+$/.test(appId)) return [];
  const appRoot = path.join(shaderRoot, appId);
  const dxvk = await filesBelow(path.join(appRoot, "DXVK_state_cache"));
  const privateDxvk = await filesBelow(path.join(appRoot, "dxvk"));
  const pipelines = (await filesBelow(path.join(appRoot, "fozpipelinesv6"))).filter((file) =>
    file.split(path.sep).some((part) => part.startsWith("steamapprun_pipeline_cache.")),
  );
  const mesa = (await filesBelow(path.join(appRoot, "mesa_shader_cache_sf"))).filter((file) =>
    ["foz_cache.foz", "foz_cache_idx.foz"].includes(path.basename(file)),
  );
  const privateDriverCaches = [
    path.join(appRoot, "amd_vk_pipeline_cache.bin"),
    ...(await filesBelow(path.join(appRoot, "nvidia"))),
  ];
  const existingPrivateDriverCaches = await Promise.all(
    privateDriverCaches.map(async (file) => {
      try {
        return (await fs.stat(file)).isFile() ? file : undefined;
      } catch {
        return undefined;
      }
    }),
  );
  return [
    ...new Set([
      ...dxvk,
      ...privateDxvk,
      ...pipelines,
      ...mesa,
      ...existingPrivateDriverCaches.filter((file): file is string => file !== undefined),
    ]),
  ];
}

export async function inspectModShaderCache(
  shaderRoots: string[],
  appId: string,
): Promise<IModShaderCacheInfo> {
  const files = (
    await Promise.all([...new Set(shaderRoots)].map((root) => modShaderCacheFiles(root, appId)))
  ).flat();
  const stats = await Promise.all(files.map((file) => fs.stat(file).catch(() => undefined)));
  return stats.reduce<IModShaderCacheInfo>(
    (result, stat) => {
      if (stat === undefined) return result;
      result.files += 1;
      result.bytes += stat.size;
      result.lastModified = Math.max(result.lastModified ?? 0, stat.mtimeMs);
      return result;
    },
    { ...EMPTY },
  );
}

export async function clearModShaderCache(shaderRoots: string[], appId: string): Promise<number> {
  const files = (
    await Promise.all([...new Set(shaderRoots)].map((root) => modShaderCacheFiles(root, appId)))
  ).flat();
  let removed = 0;
  for (const file of [...new Set(files)]) {
    try {
      await fs.unlink(file);
      removed += 1;
    } catch (err: any) {
      if (err?.code !== "ENOENT") throw err;
    }
  }
  return removed;
}

export async function resetPrivateShaderCache(
  wrapperPath: string,
  steamShaderRoots: string[],
  privateShaderRoot: string,
  appId: string,
): Promise<void> {
  await execFileAsync(wrapperPath, ["--reset", appId], {
    env: {
      ...process.env,
      VORTEX_SHADER_SOURCE_ROOTS: steamShaderRoots
        .map((root) => path.join(root, appId))
        .join(path.delimiter),
      VORTEX_SHADER_CACHE_ROOT: privateShaderRoot,
    },
  });
}
