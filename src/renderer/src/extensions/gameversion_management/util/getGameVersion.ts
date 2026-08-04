import path from "path";

import type * as exeVersionT from "exe-version";

import type { IGame } from "../../../types/IGame";
import { statAsync } from "../../../util/fs";
import lazyRequire from "../../../util/lazyRequire";
import { log } from "../../../util/log";
import type { IDiscoveryResult } from "../../gamemode_management/types/IDiscoveryResult";

const exeVersion: typeof exeVersionT = lazyRequire(() => require("exe-version"));

export function executablePath(game: IGame, discovery: IDiscoveryResult): string | undefined {
  const executable = discovery.executable || game.executable();
  if (discovery.path === undefined || executable === undefined) return undefined;
  return path.isAbsolute(executable) ? executable : path.join(discovery.path, executable);
}

export function extensionExecutablePath(
  game: IGame,
  discovery: IDiscoveryResult,
): string | undefined {
  const executable = discovery.executable || game.executable();
  if (discovery.path === undefined || executable === undefined) return undefined;
  return path.isAbsolute(executable) ? path.relative(discovery.path, executable) : executable;
}

export async function testExtProvider(game: IGame, discovery: IDiscoveryResult): Promise<boolean> {
  return Promise.resolve(game.getGameVersion !== undefined);
}

export async function getExtGameVersion(game: IGame, discovery: IDiscoveryResult): Promise<string> {
  try {
    const version: string = await game.getGameVersion(
      discovery.path,
      extensionExecutablePath(game, discovery),
    );
    if (typeof version !== "string") {
      return Promise.reject(new Error("getGameVersion functor returned an invalid type"));
    }

    return version;
  } catch (err) {
    return Promise.reject(err);
  }
}

export async function testExecProvider(game: IGame, discovery: IDiscoveryResult): Promise<boolean> {
  const exePath = executablePath(game, discovery);
  if (exePath === undefined) {
    // can be caused by a broken extension
    return Promise.resolve(false);
  }
  try {
    await statAsync(exePath);
    const version: string = exeVersion.default(exePath);
    return version === "0.0.0" ? Promise.resolve(false) : Promise.resolve(true);
  } catch (err) {
    log("error", "unable to test executable version fields", err);
    return Promise.resolve(false);
  }
}

export async function getExecGameVersion(
  game: IGame,
  discovery: IDiscoveryResult,
): Promise<string> {
  const exePath = executablePath(game, discovery);
  if (exePath === undefined) return Promise.resolve("0.0.0");
  try {
    const version: string = exeVersion.default(exePath);
    return Promise.resolve(version);
  } catch (err) {
    return Promise.resolve("0.0.0");
  }
}
