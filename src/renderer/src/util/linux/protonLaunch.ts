import * as path from "path";

import { getGameStoresSafe } from "../../extensions/gamemode_management/util/getGame";
import { GameStoreNotFound } from "../../types/IGameStore";
import { MissingInterpreter } from "../CustomErrors";
import type { ISteamEntry, Steam } from "../Steam";
import * as storeLookup from "../storeLookup";
import { isPathInsideGame, isSameGamePath } from "./gamePath";

/** Resolve a Windows launch from explicit game/tool context, never the active profile. */
export async function resolveProtonLaunch(
  executable: string,
  context: { gamePath?: string; cwd?: string } = {},
): Promise<{ store: Steam; game: ISteamEntry }> {
  let store: Steam | undefined;
  try {
    store = storeLookup.getGameStore(getGameStoresSafe(), "steam") as Steam | undefined;
  } catch (error) {
    if (!(error instanceof GameStoreNotFound)) throw error;
  }
  if (store === undefined || typeof store.runToolWithProton !== "function") {
    throw new MissingInterpreter(
      "Steam support is not ready. Enable Steam support, start Steam, then refresh Games before launching this Windows executable.",
    );
  }
  // A failed or empty scan is not permission to invoke Steam's .exe binfmt handler.
  const games = (await store.allGames()).filter(
    (game) => typeof game.gamePath === "string" && path.isAbsolute(game.gamePath),
  );
  let matches: ISteamEntry[];
  if (context.gamePath !== undefined) {
    matches = path.isAbsolute(context.gamePath)
      ? games.filter((game) => isSameGamePath(context.gamePath, game.gamePath))
      : [];
  } else {
    const cwd = context.cwd !== undefined && path.isAbsolute(context.cwd) ? context.cwd : undefined;
    const target = path.isAbsolute(executable)
      ? executable
      : cwd === undefined
        ? undefined
        : path.resolve(cwd, executable);
    matches =
      target === undefined ? [] : games.filter((game) => isPathInsideGame(target, game.gamePath));
    // Companion tools can live elsewhere while explicitly naming their game's cwd.
    if (matches.length === 0 && cwd !== undefined) {
      matches = games.filter((game) => isPathInsideGame(cwd, game.gamePath));
    }
    matches.sort((a, b) => b.gamePath.length - a.gamePath.length);
  }
  const game = matches[0];
  if (
    game === undefined ||
    !/^[1-9][0-9]*$/.test(game.appid ?? "") ||
    matches.some(
      (other) => isSameGamePath(other.gamePath, game.gamePath) && other.appid !== game.appid,
    )
  ) {
    throw new MissingInterpreter(
      "No Steam game can be associated with this Windows executable. Refresh Games and configure the tool for its game, or register a Linux interpreter.",
    );
  }
  if (game.usesProton !== true) {
    throw new MissingInterpreter(
      "Steam reports a native Linux build for this game. Select a Windows build with Proton in Steam, launch it once, then refresh Games.",
    );
  }
  return { store, game };
}
