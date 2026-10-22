import * as path from "path";

import { VortexGameId } from "@vortex/shared";

import type { IGame } from "../../../types/IGame";
import {
  currentGameUserContext,
  resolveLegacyGamePath,
  withGameUserPaths,
} from "../../../util/gameUserContext";
import type { IDiscoveryResult } from "../types/IDiscoveryResult";
import { getGameDefinition, getGameDefinitions, getGameDiscovery } from "./gameRegistry";
export {
  getGameStore,
  getGameStores,
  getGameStoresSafe,
  getGameStubDownloadInfo,
} from "./gameRegistry";
import { resolveGameVersion } from "./getGameVersion";
import { getModTypeExtensions } from "./modTypeExtensions";
// "decorate" IGame objects with added functionality
function discoveryFor(game: IGame, gamePath?: string): IDiscoveryResult | undefined {
  const running = currentGameUserContext();
  if (
    running?.gameId === game.id &&
    (gamePath === undefined || running.discovery?.path === gamePath)
  )
    return running.discovery;
  const current = getGameDiscovery(game.id);
  if (gamePath === undefined || current?.path === gamePath) return current;
  // The callback's explicit installation path cannot borrow another installation's store.
  return { path: gamePath, executable: game.executable(gamePath) };
}

function scoped<T>(game: IGame, gamePath: string | undefined, callback: () => T): T {
  return withGameUserPaths(VortexGameId(game.id), discoveryFor(game, gamePath), callback);
}

function typePaths(game: IGame): Record<string, string> {
  return getModTypeExtensions()
    .filter((ex) => ex.isSupported(game.id))
    .reduce((paths, extension) => {
      const result = extension.getPath(game);
      if (result !== undefined) paths[extension.typeId] = resolveLegacyGamePath(result);
      return paths;
    }, {});
}

function modPaths(game: IGame, gamePath: string, extensions: Record<string, string>) {
  let defaultPath = resolveLegacyGamePath(game.queryModPath(gamePath));
  if (!defaultPath) defaultPath = ".";
  if (!path.isAbsolute(defaultPath)) defaultPath = path.resolve(gamePath, defaultPath);
  return { ...extensions, "": defaultPath };
}

const gameExHandler = {
  get: (target: IGame, key: PropertyKey) => {
    if (key === "getModPaths") {
      if (process.platform !== "linux") {
        const extensions = typePaths(target);
        return (gamePath: string) => modPaths(target, gamePath, extensions);
      }
      return (gamePath: string) =>
        scoped(target, gamePath, () => modPaths(target, gamePath, typePaths(target)));
    } else if (process.platform === "linux" && key === "queryModPath") {
      return (gamePath: string) =>
        scoped(target, gamePath, () => resolveLegacyGamePath(target.queryModPath(gamePath)));
    } else if (process.platform === "linux" && key === "setup" && target.setup !== undefined) {
      const setup = target.setup;
      return (discovery: IDiscoveryResult) =>
        withGameUserPaths(VortexGameId(target.id), discovery, () => setup.call(target, discovery));
    } else if (process.platform === "linux" && key === "details" && target.details !== undefined) {
      const details = target.details;
      return new Proxy(details, {
        get: (inner, name) => {
          const value = Reflect.get(inner, name);
          if ((name === "settingsPath" || name === "appDataPath") && typeof value === "function")
            return () => scoped(target, undefined, () => resolveLegacyGamePath(value.call(inner)));
          if (name === "customOpenModsPath" && typeof value === "string")
            return scoped(target, undefined, () => resolveLegacyGamePath(value));
          return value;
        },
      });
    } else if (key === "modTypes") {
      return getModTypeExtensions().filter((ex) => ex.isSupported(target.id));
    } else if (key === "getInstalledVersion") {
      return (discovery: IDiscoveryResult) => resolveGameVersion(target, discovery);
    } else {
      return target[key];
    }
  },
};

function makeGameProxy(game: IGame): IGame {
  if (game === undefined) {
    return undefined;
  }
  return new Proxy(game, gameExHandler);
}

export function getGames(): IGame[] {
  return getGameDefinitions().map(makeGameProxy);
}

export function getGame(gameId: string): IGame {
  return makeGameProxy(getGameDefinition(gameId));
}
