import { selectors, types, util } from "@nexusmods/vortex-api";

interface IGameSupport {
  settingsPath?: (gameId: string) => string;
  appDataPath?: (gameId: string) => string;
}

let discoveryForGame: (gameId: string) => types.IDiscoveryResult | undefined = () => undefined;

function support(folder: string): IGameSupport {
  return {
    settingsPath: (gameId) =>
      util.getGameUserPath(gameId, discoveryForGame(gameId), "documents", "My Games", folder),
    appDataPath: (gameId) =>
      util.getGameUserPath(gameId, discoveryForGame(gameId), "localAppData", folder),
  };
}

const gameSupport = util.makeOverlayableDictionary<string, IGameSupport>(
  {
    fallout3: support("Fallout3"),
    falloutnv: support("FalloutNV"),
    fallout4: support("Fallout4"),
    fallout4vr: support("Fallout4VR"),
    starfield: support("Starfield"),
    oblivion: support("Oblivion"),
    skyrim: support("Skyrim"),
    skyrimse: support("Skyrim Special Edition"),
    skyrimvr: support("SkyrimVR"),
  },
  {
    xbox: {
      skyrimse: support("Skyrim Special Edition MS"),
      fallout4: support("Fallout4 MS"),
    },
    gog: {
      skyrimse: support("Skyrim Special Edition GOG"),
      enderalspecialedition: support("Enderal Special Edition GOG"),
    },
    epic: {
      skyrimse: support("Skyrim Special Edition EPIC"),
      fallout4: support("Fallout4 EPIC"),
    },
  },
  (gameId) => discoveryForGame(gameId)?.store,
);

export function initGameSupport(api: types.IExtensionApi) {
  discoveryForGame = (gameId) => selectors.discoveryByGame(api.getState(), gameId);
}

export function settingsPath(game: types.IGame): string {
  return gameSupport.get(game.id, "settingsPath")?.(game.id) ?? game.details?.settingsPath?.();
}

export function appDataPath(game: types.IGame): string {
  return gameSupport.get(game.id, "appDataPath")?.(game.id) ?? game.details?.appDataPath?.();
}
