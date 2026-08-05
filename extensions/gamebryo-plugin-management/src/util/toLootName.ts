import * as path from "path";

import { GHOST_EXT } from "../statics";
import { IPlugins } from "../types/IPlugins";
import toPluginId from "./toPluginId";

/**
 * The name to hand libloot for a plugin: the file name as it actually is on disk.
 *
 * Plugin ids are lowercased (see toPluginId) so that state lookups are case-insensitive. libloot
 * resolves the names it is given as paths inside the game's data folder, though, and on a
 * case-sensitive filesystem a lowercased id does not find `Dragonborn.esm`. libloot then falls back
 * to the ghosted form and the entire call fails:
 *
 *   failed validation of input plugin paths: the file at ".../Data/dragonborn.esm.ghost"
 *   does not have a valid plugin header
 *
 * which loses the metadata for every plugin, not just the one whose case differs. On Windows the
 * lowercased id resolves anyway, so this only shows up on Linux.
 *
 * The plugin list holds the path as it was read from the directory, so its basename carries the real
 * case. GHOST_EXT is stripped because libloot appends it itself when a plugin is ghosted. When no
 * path is known there is nothing better to try than the id, which is what the callers passed before.
 */
export function toLootName(pluginId: string, pluginList: IPlugins): string {
  const id = toPluginId(pluginId);
  const filePath = pluginList[id]?.filePath;
  return filePath !== undefined ? path.basename(filePath, GHOST_EXT) : id;
}

export default toLootName;
