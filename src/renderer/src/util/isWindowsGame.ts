import type { IDiscoveryResult } from "../extensions/gamemode_management/types/IDiscoveryResult";
import type { IGame } from "../types/IGame";
import { isWindowsExecutable } from "./linux/proton";

let executableSelectionDepth = 0;

/** Executable selectors are synchronous metadata reads, before build identity is known. */
export function isResolvingGameExecutable(): boolean {
  return executableSelectionDepth > 0;
}

/** A Windows game running through Proton or Wine, which expects case-insensitive paths. */
export function isWindowsGame(
  game: IGame | undefined,
  discovery: IDiscoveryResult | undefined,
): boolean {
  if (process.platform === "win32" || game?.executable === undefined) {
    return false;
  }
  if (discovery?.executable !== undefined) return isWindowsExecutable(discovery.executable);
  executableSelectionDepth++;
  try {
    return isWindowsExecutable(game.executable(discovery?.path) ?? "");
  } finally {
    executableSelectionDepth--;
  }
}
