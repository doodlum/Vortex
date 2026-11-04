/**
 * Lifecycle helpers for deploying SMAPI and activating it as primary tool.
 */
import type { types } from "@nexusmods/vortex-api";
import { actions, selectors, util } from "@nexusmods/vortex-api";

import { GAME_ID } from "../common";

/**
 * Deploys mods, re-runs quick discovery, and sets SMAPI as primary tool when
 * discovered, preserving an existing primary-tool choice.
 *
 * @param api Vortex extension API (`types.IExtensionApi`) used for deployment
 * events and state dispatch.
 * @returns Resolves after deployment/discovery completes and primary tool is
 * updated when available.
 */
export async function deploySMAPI(api: types.IExtensionApi): Promise<void> {
  const initial = api.getState();
  const profileId = selectors.lastActiveProfileForGame(initial, GAME_ID);
  const gamePath = selectors.discoveryByGame(initial, GAME_ID)?.path;
  await util.toPromise((cb) => api.events.emit("deploy-mods", cb));
  await util.toPromise((cb) => api.events.emit("start-quick-discovery", () => cb(null)));

  const state = api.getState();
  const discovery = selectors.discoveryByGame(state, GAME_ID);
  if (
    selectors.lastActiveProfileForGame(state, GAME_ID) !== profileId ||
    discovery?.path !== gamePath
  )
    return;
  const tool = discovery?.tools?.["smapi"];
  const primaryTool = state.settings.interface.primaryTool?.[GAME_ID];
  if (tool !== undefined && api.store !== undefined && primaryTool === undefined) {
    api.store.dispatch(actions.setPrimaryTool(GAME_ID, tool.id));
  }
}
