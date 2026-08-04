import * as fsOrig from "fs";
import * as path from "path";

import { getErrorCode } from "@vortex/shared";

import { log } from "../logging";
import { onSameVolume } from "./volumePath";

/**
 * Whether a hard link can actually be created from the staging folder into the deployment target.
 *
 * This is answered by trying it, because every cheaper test gets it wrong somewhere:
 *
 *   * comparing `statSync(a).dev` with `statSync(b).dev` -- what Vortex did -- misses mount
 *     boundaries. The kernel refuses a link across two vfsmounts even when they are the same
 *     filesystem, which is the normal case inside a Flatpak: the app's private data directory is
 *     bind-mounted separately from the host. The device ids match, the check passes, and then every
 *     single link() returns EXDEV. Deployment "succeeded" while deploying nothing, and the user was
 *     told their files were probably locked by another application.
 *   * comparing mount points fixes that, but still says yes for a filesystem that has no hard links
 *     at all -- exFAT or FAT32, which is how plenty of SD cards and external drives arrive.
 *
 * One temporary file and one link() answers all of it. Falls back to a mount-point comparison only
 * when the probe cannot run (for example the staging folder does not exist yet).
 */
export function canHardlink(stagingPath: string, targetPath: string): boolean {
  const name = `.vortex_link_probe_${process.pid}`;
  const source = path.join(stagingPath, name);
  const dest = path.join(targetPath, name);

  const cleanup = (file: string) => {
    try {
      fsOrig.unlinkSync(file);
    } catch {
      // Never let cleanup mask the result.
    }
  };

  try {
    fsOrig.writeFileSync(source, "");
  } catch (err) {
    log(
      "debug",
      "hard link probe could not write to the staging folder, comparing volumes instead",
      {
        stagingPath,
        error: getErrorCode(err),
      },
    );
    return onSameVolume(stagingPath, targetPath);
  }

  try {
    cleanup(dest);
    fsOrig.linkSync(source, dest);
    cleanup(dest);
    return true;
  } catch (err) {
    const code = getErrorCode(err);
    if (code === "EXDEV" || code === "EPERM" || code === "EMLINK" || code === "ENOSYS") {
      // EXDEV: different mount. EPERM: filesystem refuses hard links (exFAT, FAT32).
      log("info", "hard link deployment is not possible here", { stagingPath, targetPath, code });
      return false;
    }
    // Anything else (no write access to the game folder, for instance) is reported by the caller's
    // other checks; do not claim hard links are impossible on its behalf.
    log("debug", "hard link probe inconclusive", { stagingPath, targetPath, code });
    return onSameVolume(stagingPath, targetPath);
  } finally {
    cleanup(source);
  }
}

/**
 * As `canHardlink`, for a staging folder that does not exist yet.
 *
 * A path can only be offered to the user, or chosen automatically, if a link from it into the game
 * actually works -- and that cannot be known without a directory to try it from. The directory is
 * created for the probe and removed again if this call is what created it and nothing else is in it,
 * so asking the question leaves nothing behind.
 */
export function canHardlinkCandidate(candidate: string, targetPath: string): boolean {
  const created: string[] = [];
  let current = candidate;
  while (!fsOrig.existsSync(current)) {
    created.push(current);
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  try {
    fsOrig.mkdirSync(candidate, { recursive: true });
  } catch (err) {
    log("debug", "cannot create this staging folder, so it is not a usable suggestion", {
      candidate,
      error: getErrorCode(err),
    });
    return false;
  }

  try {
    return canHardlink(candidate, targetPath);
  } finally {
    // Deepest first, and only the ones this call made.
    for (const dir of created) {
      try {
        fsOrig.rmdirSync(dir);
      } catch {
        // Not empty, or not ours to remove: leave it.
      }
    }
  }
}

export default canHardlink;
