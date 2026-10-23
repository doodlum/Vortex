import { createHash } from "crypto";
import * as path from "path";

import type { IExtensionApi } from "../../types/IExtensionContext";
import type { IGame } from "../../types/IGame";
import { installPathForGame } from "../../util/selectors";
import { getGame } from "../gamemode_management/util/getGame";
import type { IDeployedFile } from "../mod_management/types/IDeploymentMethod";
import { getManifest } from "../mod_management/util/activationStore";
import type { IAetherRoot } from "./aether";

/** The folder in staging that receives what programs write into a virtual root. */
export const OVERWRITE_FOLDER = "__vfs_overwrite";

/** Whether `child` is `parent` or inside it, comparing as the game's file system would. */
export function isInside(parent: string, child: string, caseInsensitive: boolean): boolean {
  const relative = path.relative(
    caseInsensitive ? parent.toLowerCase() : parent,
    caseInsensitive ? child.toLowerCase() : child,
  );
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** A stable name for a root's write folder, so its files survive between sessions. */
export function overwriteName(gamePath: string, location: string, caseInsensitive: boolean) {
  const fold = (input: string) => path.resolve(caseInsensitive ? input.toLowerCase() : input);
  if (fold(gamePath) === fold(location)) {
    return "game";
  }
  const key = caseInsensitive ? location.toLowerCase() : location;
  return "root-" + createHash("sha1").update(key).digest("hex").slice(0, 12);
}

/** The staging file that serves a deployed file. */
export function stagingSource(stagingPath: string, file: IDeployedFile): string {
  return path.join(stagingPath, file.source, file.sourceRelPath ?? file.relPath);
}

export interface IModTypeDeployment {
  /** The mod type's deployment target. */
  targetPath: string;
  files: IDeployedFile[];
}

/**
 * Turn each mod type's virtual deployment into the session's roots. A target inside the game
 * folder belongs to root 0, the game folder itself; any other target is a root of its own.
 * Each root serves its real directory underneath the deployed files and copies programs'
 * writes up into a stable folder under staging's `__vfs_overwrite`.
 */
export function composeRoots(
  gamePath: string,
  stagingPath: string,
  deployments: IModTypeDeployment[],
  caseInsensitive: boolean,
): IAetherRoot[] {
  const roots = new Map<string, IAetherRoot>();
  const rootFor = (location: string): IAetherRoot => {
    const key = caseInsensitive ? location.toLowerCase() : location;
    let root = roots.get(key);
    if (root === undefined) {
      root = {
        location,
        base: location,
        files: [],
        writeTo: path.join(
          stagingPath,
          OVERWRITE_FOLDER,
          overwriteName(gamePath, location, caseInsensitive),
        ),
      };
      roots.set(key, root);
    }
    return root;
  };
  // The game folder is always root 0, even with nothing deployed into it.
  rootFor(gamePath);
  for (const { targetPath, files } of deployments) {
    const inGame = isInside(gamePath, targetPath, caseInsensitive);
    const root = rootFor(inGame ? gamePath : targetPath);
    const prefix = inGame ? path.relative(gamePath, targetPath) : "";
    for (const file of files) {
      root.files.push({
        path: path.join(prefix, file.target ?? "", file.relPath),
        source: stagingSource(stagingPath, file),
      });
    }
  }
  return Array.from(roots.values());
}

/** The roots for `gameId` as its manifests describe it now, every mod type included. */
export async function rootsForGame(
  api: IExtensionApi,
  gameId: string,
): Promise<IAetherRoot[] | undefined> {
  const state = api.getState();
  const game: IGame | undefined = getGame(gameId);
  const gamePath = state.settings.gameMode.discovered[gameId]?.path;
  const stagingPath = installPathForGame(state, gameId);
  if (game === undefined || gamePath === undefined || stagingPath === undefined) {
    return undefined;
  }
  const modPaths = game.getModPaths(gamePath);
  const deployments: IModTypeDeployment[] = [];
  for (const [typeId, targetPath] of Object.entries(modPaths)) {
    if (!targetPath) {
      continue;
    }
    const manifest = await getManifest(api, typeId, gameId);
    deployments.push({ targetPath, files: manifest.files });
  }
  return composeRoots(gamePath, stagingPath, deployments, process.platform === "win32");
}
