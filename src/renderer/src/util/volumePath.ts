import * as fsOrig from "fs";
import * as path from "path";

import { getErrorMessageOrDefault } from "@vortex/shared";
import * as winapi from "winapi-bindings";

import { log } from "../logging";

/**
 * The root of the volume a path lives on: a drive/mount root on Windows, the mount point on Linux.
 *
 * Windows has `GetVolumePathName` for this and Vortex used it directly. That function does not exist
 * in winapi-bindings on Linux, so every caller threw `TypeError: winapi.GetVolumePathName is not a
 * function` — which is what made the "suggest" button in Settings->Mods fail outright.
 *
 * Comparing `fs.statSync(a).dev === fs.statSync(b).dev` is not a substitute. Two paths can share a
 * device and still be on different mounts — bind mounts do exactly that — and the kernel refuses a
 * hard link across mounts even within one filesystem. Inside a Flatpak that is the normal case: the
 * app's private data directory is bind-mounted separately from the host filesystem, so a staging
 * folder there and a game under /home report the same st_dev while `link()` returns EXDEV. Vortex's
 * hardlink activator trusted the device check, deployed nothing, and told the user its files were
 * probably locked by another application.
 *
 * Paths are resolved first: a symlink can point across a mount boundary, and the kernel follows it
 * before deciding, so the resolved path is the one that matters.
 */
export function volumePath(inputPath: string): string {
  const resolved = resolveExisting(inputPath);

  if (process.platform === "win32") {
    try {
      return winapi.GetVolumePathName(resolved);
    } catch (err) {
      log("warn", "failed to resolve volume path", {
        path: resolved,
        error: getErrorMessageOrDefault(err),
      });
      return path.parse(resolved).root;
    }
  }

  return mountPointOf(resolved);
}

/**
 * The given path resolved through any symlinks, or -- when it does not exist yet -- its nearest
 * existing ancestor, which is the volume it would be created on.
 */
function resolveExisting(inputPath: string): string {
  let current = path.resolve(inputPath);
  for (;;) {
    try {
      return fsOrig.realpathSync(current);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return current;
      }
      current = parent;
    }
  }
}

/** The longest mount point that is a prefix of an absolute, resolved path. */
function mountPointOf(resolved: string): string {
  let mounts: string[];
  try {
    // Field 5 of each line is the mount point, with octal escapes for the awkward characters.
    mounts = fsOrig
      .readFileSync("/proc/self/mountinfo", "utf8")
      .split("\n")
      .map((line) => line.split(" ")[4])
      .filter((mount) => mount !== undefined)
      .map(unescapeMountPoint);
  } catch (err) {
    log("warn", "failed to read mount table", { error: getErrorMessageOrDefault(err) });
    return path.parse(resolved).root;
  }

  let best = path.parse(resolved).root;
  for (const mount of mounts) {
    if (mount.length > best.length && isPathPrefix(mount, resolved)) {
      best = mount;
    }
  }
  return best;
}

/** mountinfo escapes space, tab, newline and backslash as octal. */
function unescapeMountPoint(mount: string): string {
  return mount.replace(/\\([0-7]{3})/g, (_match, octal) => String.fromCharCode(parseInt(octal, 8)));
}

function isPathPrefix(prefix: string, candidate: string): boolean {
  if (candidate === prefix) {
    return true;
  }
  const withSep = prefix.endsWith(path.sep) ? prefix : prefix + path.sep;
  return candidate.startsWith(withSep);
}

/** Whether two paths are on the same volume, i.e. whether a hard link between them can work. */
export function onSameVolume(lhs: string, rhs: string): boolean {
  return volumePath(lhs) === volumePath(rhs);
}

export default volumePath;
