import * as path from "path";

import type { IExtensionApi } from "../../types/IExtensionContext";
import type { IState } from "../../types/IState";
import { installPathForGame } from "../../util/selectors";
import {
  forgetVirtualFiles,
  onVirtualChange,
  setOverwrite,
  setVirtualFiles,
  virtualDeployments,
} from "../../util/vfsFsView";
import { getGame } from "../gamemode_management/util/getGame";
import type { IDeployedFile } from "../mod_management/types/IDeploymentMethod";
import { getManifest, readVirtualManifestSync } from "../mod_management/util/activationStore";
import { getCurrentActivator } from "../mod_management/util/deploymentMethods";
import type { IAetherFile } from "./aether";
import { isInside, OVERWRITE_FOLDER, overwriteName, stagingSource } from "./roots";
import { VFS_DEPLOYMENT_ID } from "./VirtualDeployment";

const caseInsensitive = process.platform === "win32";
const foldPath = (input: string) =>
  caseInsensitive ? path.resolve(input).toLowerCase() : path.resolve(input);
/** One owner per mod type: two types can share a target (dinput and enb: the game folder). */
const ownerOf = (gameId: string, modType: string) => `${gameId}|${modType}`;
const gameOf = (owner: string) => owner.slice(0, owner.indexOf("|"));
/** Each owner's target, for a purge, which names the target and not the type. */
const targets = new Map<string, string>();

/** The folder a target's files are listed from: the game folder when the target is inside it. */
function rootOf(state: IState, gameId: string, targetPath: string): string {
  const gamePath = state.settings.gameMode.discovered[gameId]?.path;
  return gamePath !== undefined && isInside(gamePath, targetPath, caseInsensitive)
    ? gamePath
    : targetPath;
}

/**
 * Show one mod type's virtual deployment to Vortex's own file reads (`vfsFsView`): its files
 * at their deployed paths, listed in the game folder (or the target's own folder when it is
 * outside the game) and every folder below.
 */
export function showDeployment(
  state: IState,
  gameId: string,
  modType: string,
  targetPath: string,
  stagingPath: string,
  files: IDeployedFile[],
): void {
  const root = rootOf(state, gameId, targetPath);
  const owner = ownerOf(gameId, modType);
  targets.set(owner, foldPath(targetPath));
  setVirtualFiles(
    owner,
    [root],
    files.map((file) => ({
      deployed: path.join(targetPath, file.target ?? "", file.relPath),
      source: stagingSource(stagingPath, file),
    })),
  );
  // What programs wrote inside the root, on top, as the session shows it.
  const gamePath = state.settings.gameMode.discovered[gameId]?.path ?? root;
  setOverwrite(
    root,
    path.join(stagingPath, OVERWRITE_FOLDER, overwriteName(gamePath, root, caseInsensitive)),
  );
}

/** The mod types deployed at `targetPath` were purged: still virtual, with nothing in them. */
export function hideDeployment(state: IState, gameId: string, targetPath: string): void {
  const target = foldPath(targetPath);
  for (const [owner, ownerTarget] of targets) {
    if (gameOf(owner) === gameId && ownerTarget === target) {
      setVirtualFiles(owner, [rootOf(state, gameId, targetPath)], []);
    }
  }
}

/**
 * The game's deployment as the view holds it now, as files of the given root locations, or
 * `undefined` when the view does not hold this game. `null` when it holds a root that is not
 * among them.
 */
export function viewFilesOfGame(
  gameId: string,
  locations: string[],
): IAetherFile[][] | undefined | null {
  const owners = virtualDeployments(`${gameId}|`);
  if (owners.length === 0) {
    return undefined;
  }
  const same = (lhs: string, rhs: string) =>
    caseInsensitive
      ? path.resolve(lhs).toLowerCase() === path.resolve(rhs).toLowerCase()
      : path.resolve(lhs) === path.resolve(rhs);
  const files: IAetherFile[][] = locations.map(() => []);
  for (const { roots, files: deployed } of owners) {
    const location = roots[0];
    const at = location === undefined ? -1 : locations.findIndex((l) => same(l, location));
    if (at < 0) {
      if (deployed.length === 0) continue;
      return null;
    }
    for (const file of deployed) {
      files[at].push({ path: path.relative(location, file.deployed), source: file.source });
    }
  }
  return files;
}

/** Called with the game whose view changed. */
export function onGameViewChange(listener: (gameId: string) => void): () => void {
  return onVirtualChange((owner) => listener(gameOf(owner)));
}

/**
 * Show every mod type's deployment of `gameId` from its manifests, or none if not virtual.
 * Synchronous where the manifest can be read at once, so the view is complete before other
 * extensions' startup reads the game folder (the plugin list, for one); a manifest that needs
 * its backups follows asynchronously.
 */
export function showGameFromManifests(api: IExtensionApi, gameId: string): Promise<void> {
  const state = api.getState();
  const game = getGame(gameId);
  const gamePath = state.settings.gameMode.discovered[gameId]?.path;
  const stagingPath = installPathForGame(state, gameId);
  if (game === undefined || gamePath === undefined || stagingPath === undefined) {
    return Promise.resolve();
  }
  const virtual = getCurrentActivator(state, gameId, true)?.id === VFS_DEPLOYMENT_ID;
  const later: Array<[string, string]> = [];
  for (const [modType, targetPath] of Object.entries(game.getModPaths(gamePath))) {
    if (!targetPath) {
      continue;
    }
    if (!virtual) {
      forgetVirtualFiles(ownerOf(gameId, modType));
      setOverwrite(rootOf(state, gameId, targetPath), undefined);
      continue;
    }
    const manifest = readVirtualManifestSync(stagingPath, modType, state.app.instanceId);
    if (manifest !== undefined) {
      showDeployment(state, gameId, modType, targetPath, stagingPath, manifest.files);
    } else {
      later.push([modType, targetPath]);
    }
  }
  return later.length === 0 ? Promise.resolve() : showFromManifestsAsync(api, gameId, later);
}

async function showFromManifestsAsync(
  api: IExtensionApi,
  gameId: string,
  types: Array<[string, string]>,
): Promise<void> {
  const stagingPath = installPathForGame(api.getState(), gameId);
  for (const [modType, targetPath] of types) {
    const manifest = await getManifest(api, modType, gameId);
    showDeployment(api.getState(), gameId, modType, targetPath, stagingPath, manifest.files);
  }
}
