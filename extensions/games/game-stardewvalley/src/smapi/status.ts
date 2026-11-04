/** Synchronizes the SMAPI warning and launcher with the files actually deployed. */
import path from "node:path";

import { actions, fs, selectors } from "@nexusmods/vortex-api";
import type { types } from "@nexusmods/vortex-api";
import { getErrorCode } from "@vortex/shared";

import { GAME_ID } from "../common";
import { installedGamePlatform } from "../game/platform";
import { resolveSMAPIPlatform } from "../installers/smapi";
import { selectSdvDiscoveryPath } from "../state/selectors";
import { enableSMAPIMod } from "./install";
import { deploySMAPI } from "./lifecycle";
import { findSMAPIMod } from "./selectors";
import { downloadAndInstallSMAPI } from "./workflow";

export async function refreshSMAPIState(
  api: types.IExtensionApi,
  options: { gamePath?: string; profileId?: string } = {},
): Promise<void> {
  const initial = api.getState();
  const profileId = selectors.lastActiveProfileForGame(initial, GAME_ID);
  if (options.profileId !== undefined && options.profileId !== profileId) return;
  const discoveryPath = selectSdvDiscoveryPath(initial);
  if (options.gamePath !== undefined && options.gamePath !== discoveryPath) return;
  const gamePath = options.gamePath ?? discoveryPath;
  if (gamePath === undefined) return;
  const executable = resolveSMAPIPlatform(installedGamePlatform(gamePath)).executableName;
  let deployed: boolean;
  try {
    deployed = (await fs.statAsync(path.join(gamePath, executable))).isFile();
  } catch (err) {
    if (!["ENOENT", "ENOTDIR"].includes(getErrorCode(err) ?? "")) throw err;
    deployed = false;
  }
  // A slow filesystem check must not update the newly selected profile or game path.
  const state = api.getState();
  if (
    selectors.lastActiveProfileForGame(state, GAME_ID) !== profileId ||
    selectSdvDiscoveryPath(state) !== discoveryPath
  )
    return;
  const primaryTool = state.settings.interface.primaryTool?.[GAME_ID];
  if (deployed) {
    api.dismissNotification?.("smapi-missing");
    if (findSMAPIMod(api) && primaryTool === undefined) {
      api.store?.dispatch(actions.setPrimaryTool(GAME_ID, "smapi"));
    }
    return;
  }
  if (primaryTool === "smapi") {
    api.store?.dispatch(actions.setPrimaryTool(GAME_ID, undefined as any));
  }
  const installed = findSMAPIMod(api, true);
  api.sendNotification?.({
    id: "smapi-missing",
    type: "warning",
    title: installed ? "SMAPI is not deployed" : "SMAPI is not installed",
    message: "SMAPI is required to mod Stardew Valley.",
    actions: [
      {
        title: installed ? "Deploy" : "Get SMAPI",
        action: () =>
          installed
            ? enableSMAPIMod(api, installed.id)
                .then(() => deploySMAPI(api))
                .then(() => refreshSMAPIState(api))
            : downloadAndInstallSMAPI(api),
      },
    ],
  });
}
