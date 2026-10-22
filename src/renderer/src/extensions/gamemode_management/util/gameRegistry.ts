import type { IExtensionDownloadInfo } from "../../../types/extensions";
import type { IGame } from "../../../types/IGame";
import type { IGameStore } from "../../../types/IGameStore";
import local from "../../../util/local";
import { log } from "../../../util/log";
import type { IGameStub, GameModeManager } from "../GameModeManager";
import type { IDiscoveryResult } from "../types/IDiscoveryResult";

// this isn't nice...
const $ = local<{
  gameModeManager: GameModeManager;
  extensionGames: IGame[];
  extensionStubs: IGameStub[];
}>("gamemode-management", {
  gameModeManager: undefined,
  extensionGames: [],
  extensionStubs: [],
});

/** Raw definitions keep platform path resolution independent of decorated callbacks. */
export function getGameDefinition(gameId: string): IGame | undefined {
  return (
    $.extensionGames.find((game) => game.id === gameId) ??
    $.extensionStubs.find((stub) => stub.game.id === gameId)?.game
  );
}

export function getRegisteredGameDefinitions(): IGame[] {
  return $.extensionGames;
}

export function getGameDefinitions(): IGame[] {
  if ($.gameModeManager === undefined)
    throw new Error("getGames only available in renderer process");
  return $.gameModeManager.games;
}

export function getGameDiscovery(gameId: string): IDiscoveryResult | undefined {
  return $.gameModeManager?.getDiscovery(gameId);
}

export function getGameStubDownloadInfo(gameId: string): IExtensionDownloadInfo | undefined {
  const stub = $.extensionStubs.find((iter) => iter.game.id === gameId);
  return stub?.ext;
}

export function getGameStores(): IGameStore[] {
  if ($.gameModeManager === undefined) {
    throw new Error("getGameStores only available in renderer process");
  }

  return $.gameModeManager.gameStores || [];
}

/** Like getGameStores, but returns an empty list while the manager isn't loaded yet. */
export function getGameStoresSafe(): IGameStore[] {
  try {
    return getGameStores();
  } catch (err) {
    log("debug", "stores have yet to load", err);
    return [];
  }
}

export function getGameStore(id: string): IGameStore {
  return $.gameModeManager.gameStores.find((store) => store.id === id);
}
