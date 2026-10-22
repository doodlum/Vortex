/**
 * Displays and shares SMAPI logs through the Stardew Valley UI action.
 */
import { fs, selectors, util } from "@nexusmods/vortex-api";
import type { types } from "@nexusmods/vortex-api";

import { GAME_ID } from "../common";

/** Opens the latest available SMAPI log dialog or shows a missing-log notice. */
export async function onShowSMAPILog(api: types.IExtensionApi) {
  let logPaths: [string, string];
  try {
    const discovery = selectors.discoveryByGame(api.getState(), GAME_ID);
    if (!discovery?.path) {
      throw new util.SetupError(
        "Discover the selected Stardew Valley installation on the Games page before opening its SMAPI logs.",
      );
    }
    const logPath = (filename: string) =>
      util.getGameUserPath(GAME_ID, discovery, "appData", "StardewValley", "ErrorLogs", filename);
    logPaths = [logPath("SMAPI-crash.txt"), logPath("SMAPI-latest.txt")];
  } catch (error) {
    api.showErrorNotification?.("Failed to locate SMAPI logs", error, { allowReport: false });
    return;
  }
  try {
    await showSMAPILog(api, logPaths[0]);
  } catch (err) {
    try {
      await showSMAPILog(api, logPaths[1]);
    } catch (innerErr) {
      api.sendNotification?.({
        type: "info",
        title: "No SMAPI logs found.",
        message: "",
        displayMS: 5000,
      });
    }
  }
}

const { clipboard } = require("electron");

async function showSMAPILog(api: types.IExtensionApi, logPath: string) {
  const logData = await fs.readFileAsync(logPath, {
    encoding: "utf-8",
  });
  if (api.showDialog === undefined) {
    return;
  }
  await api.showDialog(
    "info",
    "SMAPI Log",
    {
      text:
        'Your SMAPI log is displayed below. To share it, click "Copy & Share" which will copy it to your clipboard and open the SMAPI log sharing website. ' +
        'Next, paste your code into the text box and press "save & parse log". You can now share a link to this page with others so they can see your log file.\n\n' +
        logData,
    },
    [
      {
        label: "Copy & Share log",
        action: () => {
          const timestamp = new Date().toISOString().replace(/^.+T([^\.]+).+/, "$1");
          clipboard.writeText(
            `[${timestamp} INFO Vortex] Log exported by Vortex ${util.getApplication().version}.\n` +
              logData,
          );
          return util.opn("https://smapi.io/log").catch(() => undefined);
        },
      },
      {
        label: "Close",
        action: () => undefined,
      },
    ],
  );
}
