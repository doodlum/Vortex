import * as path from "path";

/** Native Linux paths are case sensitive, including paths to Windows games. */
export function isSameGamePath(candidate: string, gamePath: string): boolean {
  return path.resolve(candidate) === path.resolve(gamePath);
}

export function isPathInsideGame(candidate: string, gamePath: string): boolean {
  const relative = path.relative(path.resolve(gamePath), path.resolve(candidate));
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}
