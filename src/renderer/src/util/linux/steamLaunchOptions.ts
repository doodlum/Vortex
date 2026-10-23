import * as fs from "fs/promises";
import * as path from "path";

import { parse, type KVBlock } from "@nexusmods/steam-kv-parser";
/**
 * A Steam game's launch options, applied the way Steam applies them, for launches that Vortex
 * starts directly through Proton. `env` holds leading `KEY=VALUE` assignments, `prefix` a wrapper
 * command before `%command%` (such as `gamemoderun`), and `suffix` the arguments after it.
 */
export interface ISteamLaunchOptions {
  env: Record<string, string>;
  prefix: string[];
  suffix: string[];
}

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;

/**
 * Split launch options into literal words, honouring single and double quotes and backslash
 * escapes. Returns undefined for anything that needs a shell (pipes, lists, redirections,
 * substitutions or globs), which Vortex does not run.
 */
function splitWords(options: string): string[] | undefined {
  const words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < options.length; index++) {
    const char = options[index];
    if (quote === "'") {
      if (char === "'") quote = undefined;
      else word += char;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = undefined;
      else if (char === "\\" && index + 1 < options.length && '"\\$`'.includes(options[index + 1]))
        word += options[++index];
      else if (char === "$" || char === "`") return undefined;
      else word += char;
      continue;
    }
    if (/\s/.test(char)) {
      if (inWord) words.push(word);
      word = "";
      inWord = false;
      continue;
    }
    inWord = true;
    if (char === "'" || char === '"') quote = char;
    else if (char === "\\") {
      if (index + 1 < options.length) word += options[++index];
    } else if (";|&<>()$`*?[]{}~#".includes(char)) return undefined;
    else word += char;
  }
  if (quote !== undefined) return undefined;
  if (inWord) words.push(word);
  return words;
}

/**
 * Parse launch options that Vortex's own wrappers have already been removed from. Without a
 * `%command%` placeholder Steam appends the words as arguments. Returns undefined when the
 * options need a shell. Adapted from Amethyst Mod Manager (GPL-3.0),
 * `parse_launch_options` in src/Utils/executables/launch.py.
 */
export function parseSteamLaunchOptions(options: string): ISteamLaunchOptions | undefined {
  const words = splitWords(options);
  if (words === undefined) return undefined;
  const command = words.indexOf("%command%");
  if (command < 0) return { env: {}, prefix: [], suffix: words };
  if (words.indexOf("%command%", command + 1) >= 0) return undefined;
  const env: Record<string, string> = {};
  let index = 0;
  for (; index < command; index++) {
    const assignment = ASSIGNMENT.exec(words[index]);
    if (assignment === null) break;
    env[assignment[1]] = assignment[2];
  }
  return { env, prefix: words.slice(index, command), suffix: words.slice(command + 1) };
}

function childBlock(parent: KVBlock | undefined, key: string): KVBlock | undefined {
  const child = parent?.children.find((entry) => entry.key.toLowerCase() === key.toLowerCase());
  return child?.type === "block" ? child : undefined;
}

/**
 * The launch options Steam has saved for a game, read from Steam's own files so that it works
 * with a stock Steam client. Steam keeps them per user in
 * `userdata/<id>/config/localconfig.vdf`; the most recently written file is the active user's.
 * Returns "" when there are none. Adapted from Amethyst Mod Manager (GPL-3.0),
 * `steam_launch_options` in src/Utils/launchers/steam.py.
 */
export async function readSteamLaunchOptions(steamPath: string, appId: string): Promise<string> {
  if (!/^\d+$/.test(appId)) throw new Error("Invalid Steam AppID");
  const userdata = path.join(steamPath, "userdata");
  let users: string[];
  try {
    users = await fs.readdir(userdata);
  } catch {
    return "";
  }
  let newest: { mtime: number; file: string } | undefined;
  for (const user of users) {
    const file = path.join(userdata, user, "config", "localconfig.vdf");
    const stat = await fs.stat(file).catch(() => undefined);
    if (stat?.isFile() === true && (newest === undefined || stat.mtimeMs > newest.mtime))
      newest = { mtime: stat.mtimeMs, file };
  }
  if (newest === undefined) return "";
  const root = parse(await fs.readFile(newest.file, "utf8"), { escapes: true });
  if (root.key.toLowerCase() !== "userlocalconfigstore") return "";
  const app = childBlock(
    childBlock(childBlock(childBlock(childBlock(root, "Software"), "Valve"), "Steam"), "apps"),
    appId,
  );
  const options = app?.children.find((entry) => entry.key.toLowerCase() === "launchoptions");
  return options?.type === "leaf" ? options.value : "";
}
