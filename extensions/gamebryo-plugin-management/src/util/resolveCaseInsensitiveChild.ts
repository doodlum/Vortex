import * as fs from "fs";
import * as path from "path";

/** Resolve one native path component with Windows-style case-insensitive lookup. */
export function resolveCaseInsensitiveChild(root: string, requested: string): string {
  if (process.platform === "win32") {
    return path.join(root, requested);
  }
  try {
    const existing = fs
      .readdirSync(root)
      .find((entry) => entry.toLowerCase() === requested.toLowerCase());
    return path.join(root, existing ?? requested);
  } catch {
    return path.join(root, requested);
  }
}

/** Resolve every component of a relative path with Windows-style case-insensitive lookup. */
export function resolveCaseInsensitivePath(root: string, requested: string): string {
  if (process.platform === "win32") {
    return path.resolve(root, requested);
  }
  return requested
    .replace(/\\/g, path.sep)
    .split(path.sep)
    .filter(Boolean)
    .reduce(resolveCaseInsensitiveChild, root);
}
