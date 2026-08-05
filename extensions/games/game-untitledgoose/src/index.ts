import path from "path";

import { fs, log, types, util } from "@nexusmods/vortex-api";
import Bluebird from "bluebird";

import { migrate020 } from "./migrations";
import { EPIC_APP_ID, GAME_ID } from "./statics";
import { toBlue } from "./util";

const BIX_CONFIG = "BepInEx.cfg";
function ensureBIXConfig(discovery: types.IDiscoveryResult): Bluebird<void> {
  const src = path.join(__dirname, BIX_CONFIG);
  const dest = path.join(discovery.path, "BepInEx", "config", BIX_CONFIG);
  return fs
    .ensureDirWritableAsync(path.dirname(dest))
    .then(() => fs.copyAsync(src, dest))
    .catch((err) => {
      if (err.code !== "EEXIST") {
        log("warn", "failed to write BIX config", err);
      }
      // nop - this is a nice to have, not a must.
      return Bluebird.resolve();
    });
}

// util.epicGamesLauncher is undefined on platforms where the Epic launcher store does not
// instantiate -- notably Linux -- so calling straight through threw
// "Cannot read properties of undefined (reading 'findByAppId')" and the game reported a crash
// instead of simply being undiscovered.
function requiresLauncher() {
  if (util.epicGamesLauncher === undefined) {
    return Bluebird.resolve(undefined);
  }
  return util.epicGamesLauncher
    .isGameInstalled(EPIC_APP_ID)
    .then((epic) => (epic ? { launcher: "epic", addInfo: EPIC_APP_ID } : undefined));
}

function findGame() {
  if (util.epicGamesLauncher === undefined) {
    return Bluebird.reject(
      new Error(`${GAME_ID}: the Epic launcher is not available on this platform`),
    );
  }
  return util.epicGamesLauncher.findByAppId(EPIC_APP_ID).then((epicEntry) => epicEntry.gamePath);
}

function modPath() {
  return path.join("BepInEx", "plugins");
}

function prepareForModding(discovery: types.IDiscoveryResult) {
  if (discovery?.path === undefined) {
    return Bluebird.reject(new util.ProcessCanceled("Game not discovered"));
  }

  return ensureBIXConfig(discovery).then(() =>
    fs.ensureDirWritableAsync(path.join(discovery.path, "BepInEx", "plugins")),
  );
}

function main(context: types.IExtensionContext) {
  context.registerGame({
    id: GAME_ID,
    name: "Untitled Goose Game",
    mergeMods: true,
    queryPath: findGame,
    queryModPath: modPath,
    requiresLauncher,
    logo: "gameart.jpg",
    executable: () => "Untitled.exe",
    requiredFiles: ["Untitled.exe", "UnityPlayer.dll"],
    setup: prepareForModding,
  });

  // context.registerMigration(toBlue(old => migrate010(context, old) as any));
  context.registerMigration(toBlue((old) => migrate020(context, old)));

  context.once(() => {
    if (context.api.ext.bepinexAddGame !== undefined) {
      context.api.ext.bepinexAddGame({
        gameId: GAME_ID,
        autoDownloadBepInEx: true,
        doorstopConfig: {
          doorstopType: "default",
          ignoreDisableSwitch: true,
        },
      });
    }
  });

  return true;
}

module.exports = {
  default: main,
};
