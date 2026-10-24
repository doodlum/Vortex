/**
 * Steam's binary app cache (`appcache/appinfo.vdf`), read for the launch entries Steam offers
 * for a game. A store launch such as `steam://launch/<appid>/option2` names one of them by its
 * `type`; a game started directly instead (virtual deployment) runs that entry's program and
 * arguments, so a launch option (Halo MCC's "Anti-Cheat Disabled") is not lost.
 */
import * as path from "path";

export interface ISteamLaunchEntry {
  /** Relative to the game's install folder, as Steam stores it. */
  executable: string;
  arguments: string[];
  workingdir?: string;
}

type KeyValues = { [key: string]: KeyValues | string | number };

const MAGIC_27 = 0x07564427;
const MAGIC_28 = 0x07564428;
const MAGIC_29 = 0x07564429;

/**
 * The `appinfo` section of `appId` in an appinfo.vdf, `undefined` when the app is not in it or
 * the file is in a format this does not know.
 */
export function readAppInfo(data: Buffer, appId: number): KeyValues | undefined {
  try {
    const magic = data.readUInt32LE(0);
    if (magic !== MAGIC_27 && magic !== MAGIC_28 && magic !== MAGIC_29) {
      return undefined;
    }
    let pos = 8;
    let names: string[] | undefined;
    if (magic === MAGIC_29) {
      // Key names are indices into a string table at the end of the file.
      let at = Number(data.readBigInt64LE(pos));
      pos += 8;
      const count = data.readUInt32LE(at);
      at += 4;
      names = [];
      for (let i = 0; i < count; i++) {
        const end = data.indexOf(0, at);
        names.push(data.toString("utf8", at, end));
        at = end + 1;
      }
    }
    for (;;) {
      const id = data.readUInt32LE(pos);
      if (id === 0) {
        return undefined;
      }
      const size = data.readUInt32LE(pos + 4);
      if (id === appId) {
        // info state, last updated, PICS token, text SHA-1, change number, binary SHA-1 (28+)
        const start = pos + 8 + 4 + 4 + 8 + 20 + 4 + (magic === MAGIC_27 ? 0 : 20);
        return section(readKeyValues(data, start, names)[0], "appinfo");
      }
      pos += 8 + size;
    }
  } catch {
    // Truncated or not what its header says.
    return undefined;
  }
}

function readKeyValues(data: Buffer, start: number, names?: string[]): [KeyValues, number] {
  const result: KeyValues = {};
  let pos = start;
  const text = (): string => {
    const end = data.indexOf(0, pos);
    if (end < 0) {
      throw new RangeError("unterminated string");
    }
    const value = data.toString("utf8", pos, end);
    pos = end + 1;
    return value;
  };
  for (;;) {
    const type = data[pos++];
    if (type === 0x08) {
      return [result, pos];
    }
    let name: string;
    if (names !== undefined) {
      name = names[data.readUInt32LE(pos)];
      pos += 4;
    } else {
      name = text();
    }
    switch (type) {
      case 0x00: {
        const [child, next] = readKeyValues(data, pos, names);
        result[name] = child;
        pos = next;
        break;
      }
      case 0x01:
        result[name] = text();
        break;
      case 0x02:
        result[name] = data.readInt32LE(pos);
        pos += 4;
        break;
      case 0x07:
        result[name] = Number(data.readBigUInt64LE(pos));
        pos += 8;
        break;
      default:
        throw new RangeError(`unknown key-value type ${type}`);
    }
  }
}

function section(values: KeyValues | undefined, key: string): KeyValues | undefined {
  const value = values?.[key];
  return typeof value === "object" ? value : undefined;
}

/** Splits Steam's launch arguments the way Windows reads a command line, quotes removed. */
export function splitLaunchArguments(input: string): string[] {
  const result: string[] = [];
  let current = "";
  let quoted = false;
  let started = false;
  for (const ch of input) {
    if (ch === '"') {
      quoted = !quoted;
      started = true;
    } else if (/\s/.test(ch) && !quoted) {
      if (started) {
        result.push(current);
      }
      current = "";
      started = false;
    } else {
      current += ch;
      started = true;
    }
  }
  if (started) {
    result.push(current);
  }
  return result;
}

/**
 * The launch entry of `appId` whose type is `option` ("option2"), for `platform`, from Steam's
 * cache in `steamFolder`. `undefined` when there is none or the cache cannot be read.
 */
export async function findSteamLaunchOption(
  readFile: (filePath: string) => Promise<Buffer>,
  steamFolder: string,
  appId: number,
  option: string,
  platform: NodeJS.Platform = process.platform,
): Promise<ISteamLaunchEntry | undefined> {
  let data: Buffer;
  try {
    data = await readFile(path.join(steamFolder, "appcache", "appinfo.vdf"));
  } catch {
    return undefined;
  }
  const launch = section(section(readAppInfo(data, appId), "config"), "launch");
  if (launch === undefined) {
    return undefined;
  }
  const os = platform === "win32" ? "windows" : platform === "darwin" ? "macos" : "linux";
  for (const entry of Object.values(launch)) {
    if (typeof entry !== "object" || entry.type !== option) {
      continue;
    }
    const oslist = section(entry, "config")?.oslist;
    if (typeof oslist === "string" && !oslist.split(",").includes(os)) {
      continue;
    }
    if (typeof entry.executable !== "string" || entry.executable === "") {
      continue;
    }
    return {
      executable: entry.executable,
      arguments: typeof entry.arguments === "string" ? splitLaunchArguments(entry.arguments) : [],
      workingdir:
        typeof entry.workingdir === "string" && entry.workingdir !== ""
          ? entry.workingdir
          : undefined,
    };
  }
  return undefined;
}
