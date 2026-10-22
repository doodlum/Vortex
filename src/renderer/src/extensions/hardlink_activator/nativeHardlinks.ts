import { lstat, readdir, unlink } from "node:fs/promises";
import * as path from "node:path";

import { getErrorCode } from "@vortex/shared";

async function* filesUnder(directory: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (err) {
    if (getErrorCode(err) === "ENOENT") return;
    throw err;
  }
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* filesUnder(absolute);
    else if (entry.isFile()) yield absolute;
  }
}

async function linkedFileIdentity(file: string): Promise<string | undefined> {
  try {
    const stats = await lstat(file, { bigint: true });
    return stats.isFile() && stats.nlink > 1n ? `${stats.dev}:${stats.ino}` : undefined;
  } catch (err) {
    if (getErrorCode(err) === "ENOENT") return undefined;
    throw err;
  }
}

async function visitFiles(root: string, visit: (file: string) => Promise<void>): Promise<void> {
  const pending: string[] = [];
  const settle = async () => {
    const results = await Promise.allSettled(pending.splice(0).map(visit));
    const errors: unknown[] = [];
    for (const result of results) {
      if (result.status === "rejected") errors.push(result.reason);
    }
    if (errors.length > 0)
      throw new AggregateError(errors, "Failed to inspect or purge hardlinked files");
  };
  for await (const file of filesUnder(root)) {
    pending.push(file);
    if (pending.length >= 50) await settle();
  }
  await settle();
}

/** The POSIX turbowalk fallback omits file IDs and link counts. Use bigint device/inode pairs. */
export async function purgeNativeHardlinks(
  installationPath: string,
  dataPath: string,
  onProgress?: (num: number, total: number) => void,
): Promise<void> {
  const owned = new Set<string>();
  await visitFiles(installationPath, async (file) => {
    const identity = await linkedFileIdentity(file);
    if (identity !== undefined) owned.add(identity);
  });
  if (owned.size === 0) return;
  let purged = 0;
  await visitFiles(dataPath, async (file) => {
    const identity = await linkedFileIdentity(file);
    if (identity === undefined || !owned.has(identity)) return;
    try {
      await unlink(file);
      if (++purged % 1000 === 0) onProgress?.(purged, owned.size);
    } catch (err) {
      if (getErrorCode(err) !== "ENOENT") throw err;
    }
  });
}
