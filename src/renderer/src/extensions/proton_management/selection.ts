import type { IState } from "@/types/IState";
import { isSameGamePath } from "@/util/linux/gamePath";
import type { ISteamEntry } from "@/util/Steam";
import * as storeLookup from "@/util/storeLookup";

import { getGameStoresSafe } from "../gamemode_management/util/getGame";
import { activeProfile } from "../profile_management/selectors";

export function activeProtonGame(state: IState): ISteamEntry | undefined {
  if (process.platform !== "linux") return undefined;
  const profile = activeProfile(state);
  const gamePath =
    profile === undefined ? undefined : state.settings.gameMode.discovered[profile.gameId]?.path;
  if (gamePath === undefined) return undefined;
  try {
    const steam = storeLookup.getGameStore(getGameStoresSafe(), "steam");
    return steam
      .snapshot()
      .entries.find(
        (entry) =>
          (entry as ISteamEntry).usesProton === true && isSameGamePath(entry.gamePath, gamePath),
      ) as ISteamEntry | undefined;
  } catch {
    // Store registration and its first scan can be pending during startup.
    return undefined;
  }
}
