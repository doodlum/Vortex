import { readdir } from "node:fs/promises";
import * as path from "node:path";

import { getErrorCode } from "@vortex/shared";

import type { Normalize } from "../../../util/getNormalizeFunc";
import type { IDeployedFile } from "../types/IDeploymentMethod";

export const BACKUP_TAG = ".vortex_backup";

function partsOf(relative: string): string[] {
  const parts = path.normalize(relative).split(path.sep).filter(Boolean);
  if (
    path.isAbsolute(relative) ||
    parts.includes("..") ||
    parts.length === 0 ||
    parts.includes(".")
  ) {
    throw new Error(`Invalid relative deployment path: ${relative}`);
  }
  return parts;
}

/** Keep Windows-game output spelling stable while retaining the mod's actual source spelling. */
export async function canonicalDeployment(
  root: string,
  files: IDeployedFile[],
  previous: IDeployedFile[],
  normalize: Normalize,
): Promise<IDeployedFile[]> {
  if (normalize("vortex-case-test") !== normalize("VORTEX-CASE-TEST")) return files;

  const fallback = new Map<string, Set<string>>();
  const directories = new Map<string, Map<string, Set<string>>>();
  const add = (map: Map<string, Set<string>>, parent: string, name: string) => {
    const key = normalize(path.join(parent, name));
    const names = map.get(key) ?? new Set<string>();
    names.add(name);
    map.set(key, names);
  };
  // Missing outputs can be recreated with the manifest's spelling, including partial deployments.
  for (const file of previous) {
    let parent = root;
    for (const part of partsOf(path.join(file.target ?? "", file.relPath))) {
      add(fallback, parent, part);
      parent = path.join(parent, part);
    }
  }

  const directory = async (parent: string) => {
    const key = parent;
    const cached = directories.get(key);
    if (cached !== undefined) return cached;
    const names = new Map<string, Set<string>>();
    let entries: string[];
    try {
      entries = await readdir(parent);
    } catch (err) {
      if (getErrorCode(err) !== "ENOENT") throw err;
      entries = [];
    }
    for (const entry of entries) add(names, parent, entry);
    for (const entry of entries.filter((name) => name.endsWith(BACKUP_TAG))) {
      const original = entry.slice(0, -BACKUP_TAG.length);
      const originalKey = normalize(path.join(parent, original));
      if (!names.has(originalKey)) add(names, parent, original);
    }
    directories.set(key, names);
    return names;
  };

  const ordered = files.map((file, index) => ({
    file,
    index,
    key: normalize(path.join(file.target ?? "", file.relPath))
      .split(path.sep)
      .join("/"),
  }));
  ordered.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  const result = [...files];
  for (const { file, index } of ordered) {
    const input = partsOf(path.join(file.target ?? "", file.relPath));
    const targetLength =
      file.target && path.normalize(file.target) !== "." ? partsOf(file.target).length : 0;
    let parent = root;
    const output: string[] = [];
    for (const part of input) {
      const names = await directory(parent);
      const key = normalize(path.join(parent, part));
      const candidates = names.get(key) ?? fallback.get(key);
      const chosen = candidates?.has(part)
        ? part
        : candidates?.size === 1
          ? [...candidates][0]
          : candidates === undefined
            ? part
            : undefined;
      if (chosen === undefined)
        throw new Error(`Ambiguous deployment path component '${part}' in '${parent}'`);
      add(names, parent, chosen);
      output.push(chosen);
      parent = path.join(parent, chosen);
    }
    const relPath = path.join(...output.slice(targetLength));
    const sourceRelPath = file.sourceRelPath ?? file.relPath;
    const canonical = { ...file, relPath };
    if (file.target !== undefined) canonical.target = output.slice(0, targetLength).join(path.sep);
    if (sourceRelPath !== relPath) canonical.sourceRelPath = sourceRelPath;
    else delete canonical.sourceRelPath;
    result[index] = canonical;
  }
  return result;
}
