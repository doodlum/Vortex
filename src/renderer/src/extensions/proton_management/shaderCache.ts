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
  changedBytes: number;
  changedFiles: number;
  copiedBytes: number;
  copiedFiles: number;
  matchesSteam: boolean;
  missingFiles: number;
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
  const markerPath = path.join(privatePath, ".vortex-steam-source.json");
  const files = (await filesBelow(privatePath)).filter((file) => file !== markerPath);
  try {
    const [marker, markerStat] = await Promise.all([
      fs.readFile(markerPath, "utf8").then((value) => JSON.parse(value)),
      fs.stat(markerPath),
    ]);
    const sourcePath = typeof marker.source === "string" ? marker.source : undefined;
    if (sourcePath === undefined) throw new Error("Private cache source is unavailable");
    const sourceFiles = (await filesBelow(sourcePath)).filter((file) => {
      const relative = path.relative(sourcePath, file);
      return relative.split(path.sep)[0] !== "downloads";
    });
    const sourceStats = new Map(
      await Promise.all(
        sourceFiles.map(
          async (file) => [path.relative(sourcePath, file), await fs.stat(file)] as const,
        ),
      ),
    );
    let changedBytes = 0;
    let changedFiles = 0;
    let copiedBytes = 0;
    let copiedFiles = 0;
    const matched = new Set<string>();
    for (const file of files) {
      const relative = path.relative(privatePath, file);
      const [privateStat, sourceStat] = await Promise.all([
        fs.stat(file),
        sourceStats.get(relative),
      ]);
      if (
        sourceStat !== undefined &&
        privateStat.size === sourceStat.size &&
        Math.abs(privateStat.mtimeMs - sourceStat.mtimeMs) < 2
      ) {
        copiedBytes += privateStat.size;
        copiedFiles += 1;
        matched.add(relative);
      } else {
        changedBytes += privateStat.size;
        changedFiles += 1;
      }
    }
    const missingFiles = sourceStats.size - matched.size;
    return {
      changedBytes,
      changedFiles,
      copiedBytes,
      copiedFiles,
      matchesSteam: changedFiles === 0 && missingFiles === 0,
      missingFiles,
      privatePath,
      seededAt: markerStat.mtimeMs,
      sourcePath,
      totalBytes: copiedBytes + changedBytes,
      totalFiles: copiedFiles + changedFiles,
    };
  } catch {
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
    return {
      ...totals,
      changedBytes: totals.totalBytes,
      changedFiles: totals.totalFiles,
      copiedBytes: 0,
      copiedFiles: 0,
      matchesSteam: false,
      missingFiles: 0,
      privatePath,
    };
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
