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
