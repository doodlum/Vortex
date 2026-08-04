import * as os from "os";
import * as path from "path";

import { log } from "../../../logging";
import getVortexPath from "../../../util/getVortexPath";
import { canHardlinkCandidate } from "../../../util/hardlinkSupport";
import { volumePath } from "../../../util/volumePath";
import { resolveInstallPath } from "./getInstallPath";

/**
 * A staging folder that hard-link deployment can actually work from.
 *
 * The default staging folder is `{USERDATA}/{GAME}/mods`, which is right on Windows and right on a
 * plain Linux install. It is wrong in a Flatpak, and wrong in a way that produces no error until much
 * later: the app's data directory is bind-mounted separately from the rest of the filesystem, so the
 * kernel refuses a hard link out of it even though both paths are on one disk. Vortex then deploys
 * nothing, reports success, and every mod looks installed while the game sees none of it.
 *
 * That is not something the user can be expected to diagnose, so nothing here guesses: each candidate
 * is tried by creating a link from it into the game's own deployment target, in the order a user would
 * prefer them. The first one that works is the answer, and if none do, the caller says so rather than
 * offering a folder that cannot deploy.
 */
export interface IStagingCandidate {
  /** What to store in the setting, `{USERDATA}` and `{GAME}` intact where they apply. */
  pattern: string;
  /** The same path resolved, which is what was probed. */
  resolved: string;
}

/**
 * Candidates in preference order:
 *
 *   1. the platform default, so a machine where it works keeps the behaviour it has always had;
 *   2. beside the game, on the game's own volume -- the only choice that survives games on a second
 *      drive or an SD card;
 *   3. the user's home directory, for when the game's volume is not writable by us.
 */
export function stagingCandidates(
  gameId: string,
  suggestDirName: string,
  gameModPath: string,
): IStagingCandidate[] {
  const patterns = [
    path.join("{USERDATA}", "{GAME}", "mods"),
    path.join(volumePath(gameModPath), suggestDirName, "{GAME}"),
    path.join(os.homedir(), suggestDirName, "{GAME}"),
  ];

  const seen = new Set<string>();
  const result: IStagingCandidate[] = [];
  for (const pattern of patterns) {
    const resolved = resolveInstallPath(pattern, gameId);
    if (seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    result.push({ pattern, resolved });
  }
  return result;
}

/** The first candidate a hard link can be made from, or undefined if none can. */
export function firstLinkableStagingPath(
  gameId: string,
  suggestDirName: string,
  gameModPath: string,
): IStagingCandidate | undefined {
  for (const candidate of stagingCandidates(gameId, suggestDirName, gameModPath)) {
    if (canHardlinkCandidate(candidate.resolved, gameModPath)) {
      log("info", "staging folder candidate accepted", {
        pattern: candidate.pattern,
        resolved: candidate.resolved,
      });
      return candidate;
    }
    log("debug", "staging folder candidate rejected: cannot hard link into the game from it", {
      resolved: candidate.resolved,
      gameModPath,
    });
  }
  return undefined;
}

/** True when the deployment target can be hard-linked to from `stagingPath`. */
export function stagingPathWorks(stagingPath: string, gameModPath: string): boolean {
  return canHardlinkCandidate(stagingPath, gameModPath);
}

export default firstLinkableStagingPath;
