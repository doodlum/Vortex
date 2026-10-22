import * as fsOrig from "fs";
import * as path from "path";

/**
 * Paths that come out of a mod archive, made usable on a case-sensitive filesystem.
 *
 * Mods are authored on Windows, where `Data\SKSE\Plugins`, `data/skse/plugins` and
 * `Fomod\Images\x.jpg` all name the same file. On Linux they name up to three different ones, and the
 * separator is not a separator at all. Two symptoms follow, and neither looks like a path problem:
 *
 *  - a mod's files land in a tree the game never reads (SKSE scans `Data/SKSE/Plugins` and finds
 *    nothing while the plugin sits in `Data/skse/plugins`), so the mod appears installed and does
 *    nothing;
 *  - a FOMOD installer's images silently do not appear, because its XML names them with backslashes,
 *    or in a case the archive does not use.
 *
 * Resolving each component against what is on disk reproduces what the Windows filesystem would have
 * done, which is what the mod author tested against.
 */

/** Turn a mod-authored relative path into one this platform can use. */
export function nativeRelPath(relPath: string): string {
  return process.platform === "win32" ? relPath : relPath.replace(/\\/g, path.sep);
}

function entriesOf(dir: string) {
  try {
    return fsOrig.readdirSync(dir);
  } catch {
    // Missing or unreadable: nothing to match, so the given case is used as-is.
    return [];
  }
}

/**
 * The path to an existing file, ignoring the case and separators the mod used.
 *
 * Returns a plain join if nothing matches, so the caller still gets a path to report in an error.
 * Not cached: callers read freshly extracted directories, where a cache would go stale.
 */
export function resolveCasePath(root: string, relPath: string): string {
  return walk(root, nativeRelPath(relPath));
}

/**
 * The same, for an absolute path that arrives already assembled.
 *
 * The FOMOD installer is a Windows-built .NET library, and the paths it hands back to Vortex's file
 * callbacks are assembled the way its author's filesystem behaves. When one of those does not resolve
 * here, its directory listing comes back empty and the install quietly produces the mod's directory
 * tree with none of its files in it.
 *
 * Returns the input unchanged when it already exists, so the common case costs one `existsSync`.
 */
export function resolveNativePath(target: string): string {
  if (process.platform === "win32") {
    return target;
  }
  const normalised = target.replace(/\\/g, path.sep);
  if (fsOrig.existsSync(normalised)) {
    return normalised;
  }
  const absolute = normalised.startsWith(path.sep);
  return walk(absolute ? path.sep : "", absolute ? normalised.slice(1) : normalised);
}

function walk(root: string, relPath: string): string {
  if (process.platform === "win32" || relPath.length === 0) {
    return path.join(root, relPath);
  }
  let current = root;
  const parts = relPath.split(path.sep).filter((part) => part.length > 0);
  parts.forEach((part) => {
    const entries = entriesOf(current);
    const matches = entries.filter((entry) => entry.toLowerCase() === part.toLowerCase());
    const existing = entries.includes(part) ? part : matches.length === 1 ? matches[0] : undefined;
    if (existing === undefined && matches.length > 1) {
      throw new Error(`Ambiguous Windows path component '${part}' in '${current}'`);
    }
    if (existing !== undefined) {
      current = path.join(current, existing);
      return;
    }
    current = path.join(current, part);
  });
  return current;
}
