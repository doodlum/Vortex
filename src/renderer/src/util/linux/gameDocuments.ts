import * as path from "path";

import type { IDiscoveryResult } from "../../extensions/gamemode_management/types/IDiscoveryResult";
import { getGame } from "../../extensions/gamemode_management/util/getGame";
import { getGameUserPath } from "../getGameUserPath";
import getVortexPath from "../getVortexPath";
import { isWindowsGame } from "../isWindowsGame";

/** Resolve Documents-based game settings inside the game's own Proton prefix. */
export async function resolveGameDocumentsPaths(
  gameId: string,
  discovery: IDiscoveryResult | undefined,
  files: readonly string[],
): Promise<string[]> {
  if (process.platform !== "linux" || files.length === 0) return [...files];
  const documents = getVortexPath("documents");
  const relativePaths = files.map((file) => {
    if (discovery?.path !== undefined) {
      const gameRelative = path.relative(discovery.path, file);
      if (
        gameRelative !== ".." &&
        !gameRelative.startsWith(".." + path.sep) &&
        !path.isAbsolute(gameRelative)
      )
        return undefined;
    }
    const relative = path.relative(documents, file);
    return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)
      ? relative
      : undefined;
  });
  if (
    relativePaths.every((relative) => relative === undefined) ||
    !isWindowsGame(getGame(gameId), discovery)
  )
    return [...files];
  return files.map((file, index) =>
    relativePaths[index] === undefined
      ? file
      : getGameUserPath(gameId, discovery, "documents", relativePaths[index]),
  );
}
