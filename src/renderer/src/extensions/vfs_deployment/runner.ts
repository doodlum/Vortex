import * as fs from "fs";
import * as path from "path";

import type { IExtensionApi, LaunchRunner } from "../../types/IExtensionContext";
import getVortexPath from "../../util/getVortexPath";
import { log } from "../../util/log";
import { activeGameId } from "../../util/selectors";
import { rescanOverwrites } from "../../util/vfsFsView";
import { getGame } from "../gamemode_management/util/getGame";
import { getCurrentActivator } from "../mod_management/util/deploymentMethods";
import { loadAether, type IAetherFile, type IAetherRoot, type IAetherSession } from "./aether";
import { deploymentForGame, gameRoots, isInside } from "./roots";
import { gameExecutable } from "./support";
import { onGameViewChange, viewFilesOfGame } from "./view";
import { VFS_DEPLOYMENT_ID } from "./VirtualDeployment";

const WINDOWS_PROGRAM = /\.(exe|com)$/i;

let sequence = 0;

interface ILiveSession {
  session: IAetherSession;
  /** The session's roots without their files. */
  base: IAetherRoot[];
  /** Files the launch added to root 0 (a virtual `steam_appid.txt`). */
  extra: IAetherFile[];
}

/** Sessions with a program running, by game. */
const live = new Map<string, Set<ILiveSession>>();

/**
 * The roots with the files the view holds for the game now (what Vortex itself sees), or
 * `undefined` when the view does not hold the game, `null` when it needs a root they lack.
 */
function rootsFromView(gameId: string, base: IAetherRoot[]): IAetherRoot[] | undefined | null {
  const files = viewFilesOfGame(
    gameId,
    base.map((root) => root.location),
  );
  if (files === undefined) {
    return undefined;
  }
  if (files === null) {
    return null;
  }
  return base.map((root, i) => ({ ...root, files: files[i] }));
}

/**
 * The game's deployment changed in the view (a deploy, a purge, a plugin ghosted or a deployed
 * file deleted): every program of the game still running sees it from its next file access,
 * as it saw links change. A program that holds a file open keeps reading what it opened.
 * Long-lived helpers (the LOOT worker) depend on this; a game is normally closed while
 * Vortex deploys.
 */
export function updateRunningSessions(gameId: string): void {
  for (const entry of live.get(gameId) ?? []) {
    const roots = rootsFromView(gameId, entry.base);
    if (roots === undefined) {
      continue;
    }
    if (roots === null) {
      // A session's roots are fixed: a target outside the game folder that is new reaches
      // programs started from now on.
      log("warn", "a running program does not see a new deployment target", { gameId });
      continue;
    }
    roots[0]?.files.push(...entry.extra);
    try {
      roots.forEach((root, id) => entry.session.setRoot(id, root));
    } catch (err) {
      log("error", "failed to update a running program's view of the game", {
        gameId,
        error: (err as Error).message,
      });
    }
  }
}

onGameViewChange(updateRunningSessions);

const sessionsDir = () => path.join(getVortexPath("temp"), "vfs-sessions");

/**
 * Remove the session folders of Vortex processes that have ended (a session open when Vortex
 * quit, the LOOT worker's for one). A folder still in use is left for the next start.
 */
export function cleanStaleSessions(): void {
  let names: string[];
  try {
    names = fs.readdirSync(sessionsDir());
  } catch {
    return;
  }
  for (const name of names) {
    const pid = Number(/-(\d+)-\d+-\d+$/.exec(name)?.[1]);
    if (!Number.isInteger(pid) || pid === process.pid || processAlive(pid)) {
      continue;
    }
    fs.rm(path.join(sessionsDir(), name), { recursive: true, force: true }, () => undefined);
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

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
 * Whether `gameId`'s game has to be started directly, in its session, rather than through its
 * store's launcher: on Windows, while it is deployed through the virtual file system.
 */
export function launchesDirectly(api: IExtensionApi, gameId: string): boolean {
  if (process.platform !== "win32") {
    return false;
  }
  const executable = gameExecutable(api.getState(), gameId);
  return executable !== undefined && vfsGameForLaunch(api, executable, gameId) !== undefined;
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
    const gameId = vfsGameForLaunch(api, executable, call.options.vfsGameId ?? call.options.gameId);
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
  const game = await deploymentForGame(api, gameId);
  if (game === undefined) {
    throw new Error("The game folder is unknown; refresh the game's discovery.");
  }
  // The manifests give every root; the view, when it holds the game, gives what Vortex sees
  // now (a ghosted plugin included).
  const fromManifests = gameRoots(game);
  const base = fromManifests.map((root) => ({ ...root, files: [] }));
  const roots = rootsFromView(gameId, base) ?? fromManifests;
  const stateDir = path.join(sessionsDir(), `${gameId}-${process.pid}-${Date.now()}-${sequence++}`);
  const plain = roots[0]?.files.length ?? 0;
  const steam = steamIdentity(gameId, executable, roots, stateDir, env);
  const session = aether.createSession(stateDir, roots);
  const entry: ILiveSession = { session, base, extra: roots[0]?.files.slice(plain) ?? [] };
  const release = () => {
    live.get(gameId)?.delete(entry);
    session.close();
    fs.rm(stateDir, { recursive: true, force: true }, () => undefined);
    // What the program wrote or deleted is in the write folders now: Vortex sees it too.
    rescanOverwrites();
  };
  try {
    session.start();
    // From here a deploy updates the session, also while the launch is starting.
    live.set(gameId, (live.get(gameId) ?? new Set()).add(entry));
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
