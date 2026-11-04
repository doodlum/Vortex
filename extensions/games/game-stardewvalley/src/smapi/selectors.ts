/**
 * Selectors for discovering and resolving active SMAPI tool/mod entries.
 */
import type { types } from "@nexusmods/vortex-api";
import { selectors, util } from "@nexusmods/vortex-api";
import { gte } from "semver";

import { GAME_ID, MOD_TYPE_SMAPI } from "../common";
import { selectSdvMods } from "../state/selectors";

/**
 * Resolves the discovered SMAPI tool entry for Stardew Valley.
 *
 * @param api Vortex extension API (`types.IExtensionApi`) used to read
 * discovery state.
 * @returns Discovered tool (`types.IDiscoveredTool`) when present and has a
 * path; otherwise `undefined`.
 */
export function findSMAPITool(api: types.IExtensionApi): types.IDiscoveredTool | undefined {
  const state = api.getState();
  const discovery = selectors.discoveryByGame(state, GAME_ID);
  const tool = discovery?.tools?.["smapi"];
  return tool?.path ? tool : undefined;
}

/**
 * Lists installed SMAPI packages, enabled in the last active profile by default.
 *
 * @param api Vortex extension API (`types.IExtensionApi`) used to read profile
 * and mod state.
 * @param includeDisabled Include packages not enabled in the last active profile.
 * @returns Matching installed SMAPI packages (`types.IMod[]`).
 */
export function getSMAPIMods(api: types.IExtensionApi, includeDisabled = false): types.IMod[] {
  const state = api.getState();
  const profileId = selectors.lastActiveProfileForGame(state, GAME_ID);
  const profile = selectors.profileById(state, profileId);
  const isActive = (modId: string) => util.getSafe(profile, ["modState", modId, "enabled"], false);
  // The installer classifies the loader payload. Local/offline archives need no Nexus metadata.
  const isSMAPI = (mod: types.IMod) => mod.type === MOD_TYPE_SMAPI;
  const mods: { [modId: string]: types.IMod } = selectSdvMods(state);
  return Object.values(mods).filter(
    (mod: types.IMod) =>
      mod.state === "installed" && isSMAPI(mod) && (includeDisabled || isActive(mod.id)),
  );
}

/**
 * Selects the newest matching SMAPI mod entry by semantic version.
 *
 * @param api Vortex extension API (`types.IExtensionApi`) used to resolve
 * active SMAPI mods.
 * @param includeDisabled Include packages not enabled in the last active profile.
 * @returns Highest-version matching installed package, or `undefined`.
 */
export function findSMAPIMod(
  api: types.IExtensionApi,
  includeDisabled = false,
): types.IMod | undefined {
  const smapiMods = getSMAPIMods(api, includeDisabled);
  return smapiMods.length === 0
    ? undefined
    : smapiMods.length > 1
      ? smapiMods.reduce<types.IMod | undefined>((prev, iter) => {
          if (prev === undefined) {
            return iter;
          }
          return gte(iter?.attributes?.version ?? "0.0.0", prev?.attributes?.version ?? "0.0.0")
            ? iter
            : prev;
        }, undefined)
      : smapiMods[0];
}
