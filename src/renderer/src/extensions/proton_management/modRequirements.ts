import * as path from "path";

import type { IState } from "@/types/IState";
import { detectRuntimeDependencies } from "@/util/linux/proton";

import { installPathForGame, modsForGame } from "../mod_management/selectors";
import type { IProfile } from "../profile_management/types/IProfile";

export function enabledModPaths(state: IState, profile: IProfile): string[] {
  const stagingPath = installPathForGame(state, profile.gameId);
  if (stagingPath === undefined) return [];

  const mods = modsForGame(state, profile.gameId);
  return Object.entries(profile.modState ?? {}).flatMap(([modId, modState]) => {
    const mod = mods[modId];
    return modState.enabled && mod?.state === "installed" && mod.installationPath !== undefined
      ? [path.join(stagingPath, mod.installationPath)]
      : [];
  });
}

export async function detectModRuntimeDependencies(
  state: IState,
  profile: IProfile,
): Promise<string[]> {
  const detected = await Promise.all(
    enabledModPaths(state, profile).map((modPath) => detectRuntimeDependencies(modPath)),
  );
  return [...new Set(detected.flat())].sort();
}
