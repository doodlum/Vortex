import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import * as path from "path";

import type { IState } from "../../../types/IState";
import { getGame } from "../../gamemode_management/util/getGame";
import { installPathForGame } from "../selectors";
import type { IDeploymentManifest } from "../types/IDeploymentManifest";
import { virtualManifestPath } from "./activationStore";
import { getCurrentActivator } from "./deploymentMethods";

/** A file as programs see it in a deployment target, and the real file that holds it. */
export interface IDeployedEntry {
  /** The file name as programs see it. */
  name: string;
  /** The real file to read: the game's own, or a mod's staged file. */
  filePath: string;
  /** Whether a mod provides it (a virtual deployment's file), not the game folder. */
  fromMod: boolean;
}

interface ICachedView {
  key: string;
  /** Deployed path (folded on Windows) to its staged source and its spelling as deployed. */
  files: Map<string, { deployed: string; source: string }>;
}

const cache = new Map<string, ICachedView>();

const fold = (input: string) =>
  process.platform === "win32" ? path.resolve(input).toLowerCase() : path.resolve(input);

/**
 * The files a virtual deployment of `gameId` serves, keyed by the deployed path. `undefined`
 * when the game does not deploy virtually, so callers fall back to the real folder. Built from
 * the manifests in staging and cached until one of them changes.
 */
async function virtualFiles(
  state: IState,
  gameId: string,
): Promise<ICachedView["files"] | undefined> {
  if (getCurrentActivator(state, gameId, true)?.virtual !== true) {
    return undefined;
  }
  const game = getGame(gameId);
  const gamePath = state.settings.gameMode.discovered[gameId]?.path;
  const stagingPath = installPathForGame(state, gameId);
  if (game === undefined || gamePath === undefined || stagingPath === undefined) {
    return undefined;
  }
  const targets = Object.entries(game.getModPaths(gamePath)).filter(([, target]) => !!target);
  const manifests = await Promise.all(
    targets.map(async ([modType, target]) => {
      const manifestPath = virtualManifestPath(stagingPath, modType);
      const mtime = (await stat(manifestPath).catch(() => undefined))?.mtimeMs ?? 0;
      return { modType, target, manifestPath, mtime };
    }),
  );
  const key = JSON.stringify([
    stagingPath,
    gamePath,
    manifests.map((m) => [m.manifestPath, m.mtime]),
  ]);
  const cached = cache.get(gameId);
  if (cached?.key === key) {
    return cached.files;
  }
  const files: ICachedView["files"] = new Map();
  for (const { target, manifestPath, mtime } of manifests) {
    if (mtime === 0) {
      continue;
    }
    let manifest: IDeploymentManifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch {
      continue;
    }
    for (const file of manifest.files ?? []) {
      const deployed = path.join(target, file.target ?? "", file.relPath);
      files.set(fold(deployed), {
        deployed,
        source: path.join(stagingPath, file.source, file.sourceRelPath ?? file.relPath),
      });
    }
  }
  cache.set(gameId, { key, files });
  return files;
}

/**
 * The files in `dirPath` (a folder inside one of `gameId`'s deployment targets) as programs see
 * them: the real folder's files, with a virtual deployment's files added on top, a mod's file
 * replacing the game's of the same name. For a game deployed with links this is the real
 * folder alone. Only files are listed, not subdirectories.
 */
export async function listDeployedFiles(
  state: IState,
  gameId: string,
  dirPath: string,
): Promise<IDeployedEntry[]> {
  const entries = new Map<string, IDeployedEntry>();
  const nameKey = (name: string) => (process.platform === "win32" ? name.toLowerCase() : name);
  const files = await virtualFiles(state, gameId);
  const dir = fold(dirPath);
  const virtualHere = [...(files?.entries() ?? [])].filter(
    ([deployedKey]) => path.dirname(deployedKey) === dir,
  );
  let real: Dirent[] = [];
  try {
    real = await readdir(dirPath, { withFileTypes: true });
  } catch (err) {
    // A folder only mods provide exists for programs; any other failure is the caller's, as
    // with a plain readdir.
    const virtualDir = [...(files?.keys() ?? [])].some((key) => key.startsWith(dir + path.sep));
    if ((err as NodeJS.ErrnoException).code !== "ENOENT" || !virtualDir) {
      throw err;
    }
  }
  for (const entry of real) {
    if (entry.isFile()) {
      entries.set(nameKey(entry.name), {
        name: entry.name,
        filePath: path.join(dirPath, entry.name),
        fromMod: false,
      });
    }
  }
  for (const [, { deployed, source }] of virtualHere) {
    const name = path.basename(deployed);
    entries.set(nameKey(name), { name, filePath: source, fromMod: true });
  }
  return Array.from(entries.values());
}
/**
 * The real file behind `filePath` as programs see it: the staged file a virtual deployment
 * serves there, else `filePath` itself if it exists. `undefined` when neither has it.
 */
export async function resolveDeployedFile(
  state: IState,
  gameId: string,
  filePath: string,
): Promise<string | undefined> {
  const files = await virtualFiles(state, gameId);
  const virtual = files?.get(fold(filePath));
  if (virtual !== undefined) {
    return virtual.source;
  }
  return (await stat(filePath).catch(() => undefined)) !== undefined ? filePath : undefined;
}
