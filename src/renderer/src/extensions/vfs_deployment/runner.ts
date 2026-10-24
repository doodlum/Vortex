import * as fs from "fs";
import * as path from "path";

import type { IExtensionApi, LaunchRunner } from "../../types/IExtensionContext";
import getVortexPath from "../../util/getVortexPath";
import { log } from "../../util/log";
import { activeGameId } from "../../util/selectors";
import { getGame } from "../gamemode_management/util/getGame";
import { getCurrentActivator } from "../mod_management/util/deploymentMethods";
import { loadAether, type IAetherRoot } from "./aether";
import { isInside, rootsForGame } from "./roots";
import { gameExecutable } from "./support";
import { VFS_DEPLOYMENT_ID } from "./VirtualDeployment";

const WINDOWS_PROGRAM = /\.(exe|com)$/i;

let sequence = 0;

/** The game a launch belongs to, when that game is deployed through the virtual file system. */
export function vfsGameForLaunch(
  api: IExtensionApi,
  executable: string,
  gameId: string | undefined,
): string | undefined {
  const state = api.getState();
  const candidate = gameId ?? activeGameId(state);
  if (candidate === undefined) {
    return undefined;
  }
  if (getCurrentActivator(state, candidate, false)?.id !== VFS_DEPLOYMENT_ID) {
    return undefined;
  }
  const gamePath = state.settings.gameMode.discovered[candidate]?.path;
  if (gamePath === undefined) {
    return undefined;
  }
  // A program named for this game, or one inside its folder (a mod's own tool included).
  if (gameId === undefined && !isInside(gamePath, executable, process.platform === "win32")) {
    return undefined;
  }
  return candidate;
}

/**
 * Starts every Windows program of a game deployed through the virtual file system inside a
 * session composed from the game's current deployment, so it sees the game folder with the
 * mods in it. Each launch gets its own session, closed (and its state removed) when everything
 * the launch started has ended.
 */
export function makeLaunchRunner(api: IExtensionApi): LaunchRunner {
  return (call) => {
    if (process.platform !== "win32") {
      return undefined;
    }
    const executable = path.resolve(call.cwd, call.executable);
    if (!WINDOWS_PROGRAM.test(executable)) {
      return undefined;
    }
    const gameId = vfsGameForLaunch(api, executable, call.options.gameId);
    if (gameId === undefined) {
      return undefined;
    }
    return startInSession(api, gameId, executable, call.args, call.options.env ?? {});
  };
}

/**
 * A Steam game started outside Steam asks Steam to start it instead (Skyrim SE exits with 53),
 * and Steam then runs its own copy without the session. The game stays when it can tell its
 * app id: a `steam_appid.txt` beside the executable and `SteamAppId`/`SteamGameId` in its
 * environment. The file is served by the session, so nothing is written into the game folder;
 * a real one there is left as it is. Returns the variables to add.
 */
export function steamIdentity(
  gameId: string,
  executable: string,
  roots: IAetherRoot[],
  stateDir: string,
  env: Record<string, string>,
): Record<string, string> {
  const appId = getGame(gameId)?.details?.steamAppId;
  const root = roots[0];
  if (appId === undefined || root === undefined || !isInside(root.location, executable, true)) {
    return {};
  }
  const relative = path.join(
    path.relative(root.location, path.dirname(executable)),
    "steam_appid.txt",
  );
  if (!fs.existsSync(path.join(root.location, relative))) {
    fs.mkdirSync(stateDir, { recursive: true });
    const source = path.join(stateDir, "steam_appid.txt");
    fs.writeFileSync(source, String(appId));
    root.files.push({ path: relative, source });
  }
  const id = String(appId);
  return {
    ...(env.SteamAppId === undefined ? { SteamAppId: id } : {}),
    ...(env.SteamGameId === undefined ? { SteamGameId: id } : {}),
  };
}

async function startInSession(
  api: IExtensionApi,
  gameId: string,
  executable: string,
  args: string[],
  env: Record<string, string>,
) {
  const aether = loadAether();
  if (aether === undefined) {
    throw new Error("The virtual file system is unavailable; reinstall Vortex to restore it.");
  }
  const roots = await rootsForGame(api, gameId);
  if (roots === undefined) {
    throw new Error("The game folder is unknown; refresh the game's discovery.");
  }
  const stateDir = path.join(
    getVortexPath("temp"),
    "vfs-sessions",
    `${gameId}-${process.pid}-${Date.now()}-${sequence++}`,
  );
  const steam = steamIdentity(gameId, executable, roots, stateDir, env);
  const session = aether.createSession(stateDir, roots);
  const release = () => {
    session.close();
    fs.rm(stateDir, { recursive: true, force: true }, () => undefined);
  };
  try {
    session.start();
    // A program only a mod provides (a script extender's loader) is staged to run, and the
    // game it starts must then be staged beside it.
    const gameExe = gameExecutable(api.getState(), gameId);
    const stageAlso =
      !fs.existsSync(executable) && gameExe !== undefined && gameExe !== executable
        ? [gameExe]
        : [];
    const launch = await session.launch({
      image: executable,
      // As for a spawned process without a shell: literal arguments.
      args: args.map((arg) => arg.replace(/"/g, "")),
      env: { ...env, ...steam },
      stageAlso,
    });
    log("info", "started in the virtual file system", {
      gameId,
      executable,
      pid: launch.pid,
      roots: session.roots(),
      notes: launch.notes,
    });
    return {
      pid: launch.pid,
      exited: launch
        .wait()
        .then((end) => ({ code: end.kind === "exited" ? (end.code ?? 0) : null }))
        .finally(release),
    };
  } catch (err) {
    release();
    throw err;
  }
}
