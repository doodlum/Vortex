import update from "immutability-helper";

import type { IReducerSpec } from "@/types/IExtensionContext";

import * as actions from "../actions/interface";
import { resolveDeployDesign, resolvePlayGate } from "../deployDesigns";

/**
 * reducer for changes to interface settings
 */
const settingsReducer: IReducerSpec = {
  reducers: {
    [actions.setLanguage as any]: (state, payload) =>
      update(state, { language: { $set: payload } }),
    [actions.setAdvancedMode as any]: (state, payload) =>
      update(state, { advanced: { $set: payload.advanced } }),
    [actions.setProfilesVisible as any]: (state, payload) =>
      update(state, { profilesVisible: { $set: payload.visible } }),
    [actions.setDesktopNotifications as any]: (state, payload) =>
      update(state, { desktopNotifications: { $set: payload } }),
    [actions.setHideTopLevelCategory as any]: (state, payload) =>
      update(state, { hideTopLevelCategory: { $set: payload.hide } }),
    [actions.showUsageInstruction as any]: (state, payload) =>
      update(state, { usage: { [payload.usageId]: { $set: payload.show } } }),
    [actions.setRelativeTimes as any]: (state, payload) =>
      update(state, { relativeTimes: { $set: payload } }),
    [actions.setForegroundDL as any]: (state, payload) =>
      update(state, { foregroundDL: { $set: payload } }),
    [actions.setAlwaysCompactHeaders as any]: (state, payload) =>
      update(state, { alwaysCompactHeaders: { $set: payload } }),
    // Deliberately absent from the defaults below: unset means "follow the OS".
    [actions.setReduceMotion as any]: (state, payload) =>
      update(state, { reduceMotion: { $set: payload } }),
    // Absent too: unset means the recommended design. A removed design becomes that.
    [actions.setDeployButtonStyle as any]: (state, payload) =>
      update(state, { deployButtonStyle: { $set: resolveDeployDesign(payload) } }),
    [actions.setPlayWhilePending as any]: (state, payload) =>
      update(state, { playWhilePending: { $set: resolvePlayGate(payload) } }),
  },
  defaults: {
    language: "en",
    advanced: false,
    profilesVisible: true,
    desktopNotifications: false,
    hideTopLevelCategory: false,
    relativeTimes: true,
    foregroundDL: true,
    alwaysCompactHeaders: false,
    usage: {},
  },
};

export default settingsReducer;
