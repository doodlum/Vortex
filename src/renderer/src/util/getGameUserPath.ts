import * as fs from "fs";
import * as path from "path";

import { getErrorCode } from "@vortex/shared";

import type { IDiscoveryResult } from "../extensions/gamemode_management/types/IDiscoveryResult";
import {
  getGameDefinition as getGame,
  getGameStoresSafe,
} from "../extensions/gamemode_management/util/gameRegistry";
import { GameEntryNotFound, GameStoreNotFound } from "../types/IGameStore";
import { nativeRelPath, resolveCasePath } from "./casePath";
import { MissingInterpreter } from "./CustomErrors";
import getVortexPath from "./getVortexPath";
import { isWindowsGame } from "./isWindowsGame";
import { getWinePrefixPath } from "./linux/proton";
import { findGameEntry } from "./storeLookup";

export type GameUserPath = "documents" | "appData" | "localAppData" | "localLowAppData";

export function getHostGameUserPath(name: GameUserPath): string {
  return name === "localLowAppData"
    ? path.resolve(getVortexPath("appData"), "..", "LocalLow")
    : getVortexPath(name);
}

const setupMessage =
  "The Windows game's Proton prefix is unavailable. Enable Proton and launch the game in Steam, then refresh game discovery before editing its settings.";

export function getGameProtonPrefix(discovery: IDiscoveryResult | undefined): string {
  if (discovery?.store !== "steam" || discovery.path === undefined)
    throw new MissingInterpreter(setupMessage);
  let entry;
  try {
    entry = findGameEntry(getGameStoresSafe(), "path", discovery.path, "steam");
  } catch (error) {
    if (error instanceof GameEntryNotFound || error instanceof GameStoreNotFound)
      throw new MissingInterpreter(setupMessage);
    throw error;
  }
  if (
    !("usesProton" in entry) ||
    entry.usesProton !== true ||
    !("compatDataPath" in entry) ||
    typeof entry.compatDataPath !== "string" ||
    !path.isAbsolute(entry.compatDataPath)
  )
    throw new MissingInterpreter(setupMessage);
  const prefix = getWinePrefixPath(entry.compatDataPath);
  try {
    if (
      !fs.statSync(path.join(prefix, "drive_c", "users", "steamuser")).isDirectory() ||
      !fs.statSync(path.join(prefix, "system.reg")).isFile()
    )
      throw new MissingInterpreter(setupMessage);
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(getErrorCode(error)))
      throw new MissingInterpreter(setupMessage);
    throw error;
  }
  return prefix;
}

function userSubpath(subpaths: string[]): string {
  const relative = path.normalize(
    nativeRelPath(path.join(...(subpaths.length > 0 ? subpaths : ["."]))),
  );
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(".." + path.sep))
    throw new TypeError("Game user subpaths must stay inside the selected user folder.");
  return relative;
}

/** Internal resolver for a prefix whose owner and initialized identity have already been checked. */
export function resolveProtonUserPath(
  prefix: string,
  name: GameUserPath,
  ...subpaths: string[]
): string {
  const relative = userSubpath(subpaths);
  const user = path.join(prefix, "drive_c", "users", "steamuser");
  const folders: Record<GameUserPath, string[]> = {
    documents: ["Documents"],
    appData: ["AppData", "Roaming"],
    localAppData: ["AppData", "Local"],
    localLowAppData: ["AppData", "LocalLow"],
  };
  return resolveCasePath(user, path.join(...folders[name], relative));
}

/**
 * Resolve one game's user folder from its explicit discovery and the latest Steam scan.
 * Synchronous for queryModPath/mod-type callbacks; never starts a scan or creates a prefix.
 * A missing Windows-game prefix fails with setup guidance instead of using host folders.
 */
export function getGameUserPath(
  gameId: string,
  discovery: IDiscoveryResult | undefined,
  name: GameUserPath,
  ...subpaths: string[]
): string {
  const relative = userSubpath(subpaths);
  if (process.platform !== "linux" || !isWindowsGame(getGame(gameId), discovery))
    return path.join(getHostGameUserPath(name), relative);
  return resolveProtonUserPath(getGameProtonPrefix(discovery), name, relative);
}

/** Resolve an absolute Windows path read from this game's configuration through its Wine drives. */
export function resolveGameWindowsPath(
  gameId: string,
  discovery: IDiscoveryResult | undefined,
  filePath: string,
): string {
  if (process.platform !== "linux" || !isWindowsGame(getGame(gameId), discovery)) return filePath;
  return resolveProtonWindowsPath(getGameProtonPrefix(discovery), filePath);
}

/** Internal drive resolver after executable classification and prefix validation. */
export function resolveProtonWindowsPath(prefix: string, filePath: string): string {
  const normalized = path.win32.normalize(filePath);
  const drive = /^([a-z]):[\\/]/i.exec(normalized)?.[1].toLowerCase();
  if (drive === undefined)
    throw new MissingInterpreter(
      "The game's configured Windows path must use an absolute drive path.",
    );
  const driveRoot =
    drive === "c"
      ? path.join(prefix, "drive_c")
      : fs.realpathSync(path.join(prefix, "dosdevices", drive + ":"));
  return resolveCasePath(driveRoot, normalized.slice(3).split(/[\\/]/).join(path.sep));
}
