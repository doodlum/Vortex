import * as path from "path";

import type { IExtensionApi } from "../../types/IExtensionContext";
import type { IState } from "../../types/IState";
import { installPathForGame } from "../../util/selectors";
import { setVirtualFiles } from "../../util/vfsFsView";
import { getGame } from "../gamemode_management/util/getGame";
import type { IDeployedFile } from "../mod_management/types/IDeploymentMethod";
import { getManifest } from "../mod_management/util/activationStore";
import { getCurrentActivator } from "../mod_management/util/deploymentMethods";
import { isInside, stagingSource } from "./roots";
import { VFS_DEPLOYMENT_ID } from "./VirtualDeployment";

const caseInsensitive = process.platform === "win32";
const ownerOf = (gameId: string, targetPath: string) =>
  `${gameId}|${caseInsensitive ? path.resolve(targetPath).toLowerCase() : path.resolve(targetPath)}`;

/**
 * Show one mod type's virtual deployment to Vortex's own file reads (`vfsFsView`): its files
 * at their deployed paths, listed in the game folder (or the target's own folder when it is
 * outside the game) and every folder below.
 */
export function showDeployment(
  state: IState,
  gameId: string,
  targetPath: string,
  stagingPath: string,
  files: IDeployedFile[],
): void {
  const gamePath = state.settings.gameMode.discovered[gameId]?.path;
  const root =
    gamePath !== undefined && isInside(gamePath, targetPath, caseInsensitive)
      ? gamePath
      : targetPath;
  setVirtualFiles(
    ownerOf(gameId, targetPath),
    [root],
    files.map((file) => ({
      deployed: path.join(targetPath, file.target ?? "", file.relPath),
      source: stagingSource(stagingPath, file),
    })),
  );
}

/** Stop showing a mod type's deployment (it was purged). */
export function hideDeployment(gameId: string, targetPath: string): void {
  setVirtualFiles(ownerOf(gameId, targetPath), [], []);
}

/** Show every mod type's deployment of `gameId` from its manifests, or none if not virtual. */
export async function showGameFromManifests(api: IExtensionApi, gameId: string): Promise<void> {
  const state = api.getState();
  const game = getGame(gameId);
  const gamePath = state.settings.gameMode.discovered[gameId]?.path;
  const stagingPath = installPathForGame(state, gameId);
  if (game === undefined || gamePath === undefined || stagingPath === undefined) {
    return;
  }
  const virtual = getCurrentActivator(state, gameId, true)?.id === VFS_DEPLOYMENT_ID;
  for (const [modType, targetPath] of Object.entries(game.getModPaths(gamePath))) {
    if (!targetPath) {
      continue;
    }
    if (!virtual) {
      hideDeployment(gameId, targetPath);
      continue;
    }
    const manifest = await getManifest(api, modType, gameId);
    showDeployment(state, gameId, targetPath, stagingPath, manifest.files);
  }
}
