import type { Dirent } from "fs";
import * as fsPromises from "fs/promises";
import * as path from "path";

import { parse, type KVBlock } from "@nexusmods/steam-kv-parser";

import * as fs from "../fs";
import { log } from "../log";
import { readCustomProtonName } from "./protonMetadata";

export interface IProtonInfo {
  usesProton: boolean;
  compatDataPath?: string;
  protonPath?: string;
}

function childBlock(parent: KVBlock | undefined, key: string): KVBlock | undefined {
  const child = parent?.children.find((entry) => entry.key.toLowerCase() === key.toLowerCase());
  return child?.type === "block" ? child : undefined;
}

function childValue(parent: KVBlock | undefined, key: string): string | undefined {
  const child = parent?.children.find((entry) => entry.key.toLowerCase() === key.toLowerCase());
  return child?.type === "leaf" ? child.value : undefined;
}

export interface IInstalledProton {
  id: string;
  name: string;
  path: string;
  source: "steam" | "custom";
  compatibilityName?: string;
}

/** Convert an installed Proton folder to the compatibility-tool key Steam stores for a game. */
export function protonConfigName(tool: IInstalledProton): string | undefined {
  if (tool.source === "custom") return tool.compatibilityName;
  const stable = /^Proton (\d+)(?:\.\d+)?$/i.exec(tool.name);
  if (stable !== null) return `proton_${stable[1]}`;
  if (/^Proton(?:\s*-)?\s*Experimental$/i.test(tool.name)) return "proton_experimental";
  if (/^Proton\s+Hotfix$/i.test(tool.name)) return "proton_hotfix";
  return undefined;
}

export interface IPrefixInventory {
  components: string[];
  compatDataPath: string;
  prefixPath: string;
  winetricks: string[];
}

const RUNTIME_SIGNATURES: Array<{ pattern: RegExp; verb: string }> = [
  { pattern: /(?:VCRUNTIME|MSVCP)140(?:_\d)?\.DLL/i, verb: "vcrun2022" },
  { pattern: /MSVCR120\.DLL/i, verb: "vcrun2013" },
  { pattern: /MSVCR110\.DLL/i, verb: "vcrun2012" },
  { pattern: /MSVCR100\.DLL/i, verb: "vcrun2010" },
  { pattern: /D3DCOMPILER_47\.DLL/i, verb: "d3dcompiler_47" },
  { pattern: /D3DCOMPILER_43\.DLL/i, verb: "d3dcompiler_43" },
  { pattern: /D3DX9_\d+\.DLL/i, verb: "d3dx9" },
  { pattern: /XINPUT1_[1-4]\.DLL/i, verb: "xinput" },
  { pattern: /XAUDIO2_[0-9]\.DLL/i, verb: "xact" },
];

const RUNTIME_COMPONENT_FILES: Record<string, string[]> = {
  d3dcompiler_43: ["d3dcompiler_43.dll"],
  d3dcompiler_47: ["d3dcompiler_47.dll"],
  d3dx9: ["d3dx9_43.dll"],
  vcrun2010: ["msvcr100.dll"],
  vcrun2012: ["msvcr110.dll"],
  vcrun2013: ["msvcr120.dll"],
  vcrun2022: ["vcruntime140.dll", "msvcp140.dll"],
  xact: ["xaudio2_7.dll"],
  xinput: ["xinput1_3.dll"],
};

async function portableExecutableFiles(rootPath: string, depth = 8): Promise<string[]> {
  if (depth < 0) return [];
  let entries: Dirent[];
  try {
    entries = await fsPromises.readdir(rootPath, { withFileTypes: true });
  } catch {
    return [];
  }
  const nested = await Promise.all(
    entries.map((entry) => {
      const fullPath = path.join(rootPath, entry.name);
      if (entry.isDirectory()) return portableExecutableFiles(fullPath, depth - 1);
      return Promise.resolve(
        entry.isFile() && /\.(?:dll|exe)$/i.test(entry.name) ? [fullPath] : [],
      );
    }),
  );
  return nested.flat();
}

/** Find runtime hints in executable bytes; this does not prove a dependency is required. */
export async function detectRuntimeDependencies(gamePath: string): Promise<string[]> {
  const verbs = new Set<string>();
  for (const filePath of await portableExecutableFiles(gamePath)) {
    let handle: fsPromises.FileHandle | undefined;
    try {
      handle = await fsPromises.open(filePath, "r");
      const buffer = Buffer.alloc(8 * 1024 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const imports = buffer.subarray(0, bytesRead).toString("latin1").replaceAll("\0", "");
      for (const signature of RUNTIME_SIGNATURES) {
        if (signature.pattern.test(imports)) verbs.add(signature.verb);
      }
    } catch {
      // Unreadable optional executables do not prevent scanning the rest of the game.
    } finally {
      await handle?.close();
    }
  }
  return [...verbs].sort();
}

/** Read winetricks records and runtime file presence; presence does not prove a native runtime. */
export async function inspectPrefix(compatDataPath: string): Promise<IPrefixInventory> {
  const prefixPath = getWinePrefixPath(compatDataPath);
  const logPath = path.join(prefixPath, "winetricks.log");
  let winetricks: string[] = [];
  try {
    const contents = await fs.readFileAsync(logPath, "utf8");
    winetricks = contents
      .toString()
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter((entry, index, all) => entry.length > 0 && all.indexOf(entry) === index);
  } catch {
    // A clean Proton prefix normally has no winetricks log.
  }
  const components = new Set(winetricks);
  for (const [verb, files] of Object.entries(RUNTIME_COMPONENT_FILES)) {
    const installed = await Promise.all(
      files.map((file) =>
        Promise.all([
          pathExists(path.join(prefixPath, "drive_c", "windows", "system32", file)),
          pathExists(path.join(prefixPath, "drive_c", "windows", "syswow64", file)),
        ]).then((architectures) => architectures.some(Boolean)),
      ),
    );
    if (installed.every(Boolean)) components.add(verb);
  }
  return { compatDataPath, components: [...components].sort(), prefixPath, winetricks };
}

/** Discover installed official and custom Proton distributions from Steam itself. */
export async function listInstalledProton(
  steamPath: string,
  libraryPaths?: string[],
): Promise<IInstalledProton[]> {
  const roots: Array<{ path: string; source: IInstalledProton["source"] }> = [
    ...(libraryPaths ?? (await getSteamLibraryPaths(steamPath))).map((library) => ({
      path: path.join(library, "steamapps", "common"),
      source: "steam" as const,
    })),
    { path: path.join(steamPath, "compatibilitytools.d"), source: "custom" },
  ];
  const result: IInstalledProton[] = [];
  const seen = new Set<string>();

  for (const root of roots) {
    try {
      const entries = await fs.readdirAsync(root.path);
      for (const name of entries) {
        const installPath = path.join(root.path, name);
        if ((await pathExists(path.join(installPath, "proton"))) === false) {
          continue;
        }
        const resolved = await fsPromises.realpath(installPath);
        if (seen.has(resolved)) continue;
        seen.add(resolved);
        const custom =
          root.source === "custom"
            ? await readCustomProtonName(installPath).catch(() => undefined)
            : undefined;
        result.push({
          id: resolved,
          name,
          path: installPath,
          source: root.source,
          compatibilityName: custom?.path === resolved ? custom.name : undefined,
        });
      }
    } catch {
      // An absent custom-tools directory is normal.
    }
  }

  return result.sort((lhs, rhs) => lhs.name.localeCompare(rhs.name, undefined, { numeric: true }));
}

/**
 * Check if a game uses Proton by looking for its compatdata folder
 */
export async function detectProtonUsage(steamAppsPath: string, appId: string): Promise<boolean> {
  const compatDataPath = path.join(steamAppsPath, "compatdata", appId);
  try {
    return (await fsPromises.stat(getWinePrefixPath(compatDataPath))).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Get the compatdata path for a game
 */
export function getCompatDataPath(steamAppsPath: string, appId: string): string {
  return path.join(steamAppsPath, "compatdata", appId);
}

/**
 * Get the Wine prefix path within compatdata
 */
export function getWinePrefixPath(compatDataPath: string): string {
  return path.join(compatDataPath, "pfx");
}

/**
 * Read Steam's config.vdf to find the configured Proton version for a game
 */
export async function getConfiguredProtonName(
  steamPath: string,
  appId: string,
): Promise<string | undefined> {
  const configPath = path.join(steamPath, "config", "config.vdf");
  try {
    const configData = await fs.readFileAsync(configPath, "utf8");
    const config = parse(configData.toString());
    if (config.key.toLowerCase() !== "installconfigstore") return undefined;
    const steam = childBlock(childBlock(childBlock(config, "Software"), "Valve"), "Steam");
    return childValue(childBlock(childBlock(steam, "CompatToolMapping"), appId), "name");
  } catch (err: any) {
    log("debug", "Could not read Steam config.vdf", { error: err?.message });
    return undefined;
  }
}

/** Where Vortex learned which Proton Steam runs a game with. */
export type SteamProtonSource = "game" | "prefix" | "default" | "newest";

export interface ISteamProtonChoice {
  /** Steam's compatibility-tool key, such as `proton_experimental` or `GE-Proton10-4`. */
  name?: string;
  /** The installed tool, when it is installed. */
  tool?: IInstalledProton;
  source: SteamProtonSource;
}

export interface ISteamProtonReaders {
  configured: (steamPath: string, appId: string) => Promise<string | undefined>;
  read: (file: string) => Promise<string>;
}

function findProtonTool(tools: IInstalledProton[], name: string): IInstalledProton | undefined {
  return tools.find((tool) => protonConfigName(tool) === name || tool.name === name);
}

/**
 * The Proton that last ran a game's prefix, which Steam records in `compatdata/<appid>/config_info`.
 * It reflects the version Steam chose itself, including Valve's per-game choices, when the game
 * has no Steam setting of its own. Adapted from Amethyst Mod Manager (GPL-3.0),
 * `find_proton_for_game` in src/Utils/launchers/steam.py.
 */
async function prefixProtonTool(
  compatDataPath: string,
  tools: IInstalledProton[],
  read: ISteamProtonReaders["read"],
): Promise<IInstalledProton | undefined> {
  const lines = (await read(path.join(compatDataPath, "config_info")).catch(() => "")).split("\n");
  for (const line of lines) {
    const exact = tools.find((tool) => line.startsWith(tool.path + "/"));
    if (exact !== undefined) return exact;
    const folder = /\/(?:steamapps\/common|compatibilitytools\.d)\/([^/]+)\//.exec(line)?.[1];
    const named = tools.find((tool) => path.basename(tool.path) === folder);
    if (named !== undefined) return named;
  }
  return undefined;
}

/**
 * The Proton Steam runs a game with, read from Steam's own files so that it works with a stock
 * Steam client: the game's own setting, then the version that last ran its prefix, then Steam's
 * default for Windows games, then the newest installed (Experimental before stable releases).
 * Vortex never changes it; the user picks the version in Steam.
 */
export async function resolveSteamProton(
  steamPath: string,
  appId: string,
  compatDataPath: string | undefined,
  tools: IInstalledProton[],
  readers: ISteamProtonReaders = {
    configured: getConfiguredProtonName,
    read: (file) => fsPromises.readFile(file, "utf8"),
  },
): Promise<ISteamProtonChoice> {
  const perGame = await readers.configured(steamPath, appId);
  if (perGame) return { name: perGame, tool: findProtonTool(tools, perGame), source: "game" };
  if (compatDataPath !== undefined) {
    const used = await prefixProtonTool(compatDataPath, tools, readers.read);
    if (used !== undefined) return { name: protonConfigName(used), tool: used, source: "prefix" };
  }
  const steamDefault = await readers.configured(steamPath, "0");
  if (steamDefault)
    return { name: steamDefault, tool: findProtonTool(tools, steamDefault), source: "default" };
  const official = tools.filter((tool) => tool.source === "steam");
  const newest =
    official.find((tool) => protonConfigName(tool) === "proton_experimental") ??
    official.filter((tool) => /^Proton \d+(?:\.\d+)?$/i.test(tool.name)).at(-1);
  return {
    name: newest === undefined ? undefined : protonConfigName(newest),
    tool: newest,
    source: "newest",
  };
}
/**
 * Find the default Proton version (fallback)
 */
export async function getDefaultProtonName(steamPath: string): Promise<string | undefined> {
  return getConfiguredProtonName(steamPath, "0");
}

/**
 * Check if a path exists asynchronously
 */
async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.statAsync(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Include the client library even when removable libraries are unavailable. */
export async function getSteamLibraryPaths(steamPath: string): Promise<string[]> {
  const result = new Set([steamPath]);
  try {
    const contents = await fsPromises
      .readFile(path.join(steamPath, "config", "libraryfolders.vdf"), "utf8")
      .catch(() =>
        fsPromises.readFile(path.join(steamPath, "steamapps", "libraryfolders.vdf"), "utf8"),
      );
    const libraries = parse(contents);
    if (libraries.key.toLowerCase() !== "libraryfolders") return [...result];
    for (const child of libraries.children) {
      if (!/^\d+$/.test(child.key)) continue;
      const location = child.type === "leaf" ? child.value : childValue(child, "path");
      if (location !== undefined && path.isAbsolute(location)) result.add(path.normalize(location));
    }
  } catch {
    // A fresh Steam client can lack libraryfolders.vdf.
  }
  return [...result];
}

/** Resolve exact compatibility-tool keys rather than substring versions (9 versus 19). */
export async function resolveProtonPath(
  steamBasePath: string,
  steamLibraryPaths: string[],
  protonName: string | undefined,
): Promise<string | undefined> {
  if (!protonName) return undefined;
  const tools = await listInstalledProton(steamBasePath, steamLibraryPaths);
  return tools.find((tool) => tool.name === protonName || protonConfigName(tool) === protonName)
    ?.path;
}

export async function findLatestProton(steamLibraryPaths: string[]): Promise<string | undefined> {
  if (steamLibraryPaths.length === 0) return undefined;
  const tools = (await listInstalledProton(steamLibraryPaths[0], steamLibraryPaths)).filter(
    (tool) => tool.source === "steam" && protonConfigName(tool) !== undefined,
  );
  return (
    tools.find((tool) => protonConfigName(tool) === "proton_experimental")?.path ??
    tools.filter((tool) => /^Proton \d+(?:\.\d+)?$/i.test(tool.name)).at(-1)?.path
  );
}

export async function findLatestStableProtonName(steamPath: string): Promise<string | undefined> {
  const stable = (await listInstalledProton(steamPath)).filter(
    (tool) => tool.source === "steam" && /^Proton \d+(?:\.\d+)?$/i.test(tool.name),
  );
  const latest = stable.at(-1);
  return latest === undefined ? undefined : protonConfigName(latest);
}

/**
 * Get full Proton info for a game
 */
export async function getProtonInfo(
  steamBasePath: string,
  steamLibraryPaths: string[],
  steamAppsPath: string,
  appId: string,
): Promise<IProtonInfo> {
  const confProtonName = await getConfiguredProtonName(steamBasePath, appId);
  const configuredPath = await resolveProtonPath(steamBasePath, steamLibraryPaths, confProtonName);
  const configuredProton =
    configuredPath !== undefined || /^(?:proton_|GE-Proton)/i.test(confProtonName ?? "");
  const usesProton = confProtonName
    ? configuredProton
    : await detectProtonUsage(steamAppsPath, appId);
  if (!usesProton) {
    return { usesProton: false };
  }

  const compatDataPath = getCompatDataPath(steamAppsPath, appId);

  const tools = await listInstalledProton(steamBasePath, steamLibraryPaths);
  const protonPath = (await resolveSteamProton(steamBasePath, appId, compatDataPath, tools)).tool
    ?.path;
  return { usesProton: true, compatDataPath, protonPath };
}

/**
 * Check if a file is a Windows executable
 */
export function isWindowsExecutable(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return [".exe", ".bat", ".cmd"].includes(ext);
}

export interface IProtonEnvironmentOptions {
  compatDataPath: string;
  steamPath: string;
  appId: string;
  /** The game's install directory, as Steam passes it to Proton. */
  installPath?: string;
  steamHome?: string;
  existingEnv?: Record<string, string>;
}

/** Build a child environment for the selected Steam game's prefix and native client bridge. */
export function buildProtonEnvironment({
  compatDataPath,
  steamPath,
  appId,
  installPath,
  steamHome,
  existingEnv,
}: IProtonEnvironmentOptions): Record<string, string> {
  return {
    ...existingEnv,
    ...(steamHome !== undefined && existingEnv?.HOME === undefined ? { HOME: steamHome } : {}),
    // The full app context Steam gives a game, so a context inherited from another game (for
    // example from Gaming Mode) cannot leak in, and GE-Proton doesn't fall back to app ID 0.
    // Adapted from Amethyst Mod Manager (GPL-3.0), src/Utils/executables/launch.py.
    SteamAppId: appId,
    SteamGameId: appId,
    SteamOverlayGameId: appId,
    STEAM_COMPAT_APP_ID: appId,
    ...(installPath !== undefined ? { STEAM_COMPAT_INSTALL_PATH: installPath } : {}),
    STEAM_COMPAT_DATA_PATH: compatDataPath,
    STEAM_COMPAT_CLIENT_INSTALL_PATH: steamPath,
    WINEPREFIX: getWinePrefixPath(compatDataPath),
  };
}

// Variables people set to tune or debug Proton, Wine, DXVK and the GPU driver. Identity and
// path variables (WINEPREFIX, STEAM_COMPAT_*, SteamAppId) are deliberately absent: Vortex sets
// those for the selected game. Adapted from Amethyst Mod Manager (GPL-3.0),
// src/Utils/flatpak/env.py.
const TUNING_EXACT = new Set([
  "WINEDEBUG",
  "WINEDLLOVERRIDES",
  "MANGOHUD",
  "DRI_PRIME",
  "SteamDeck",
]);
const TUNING_PREFIXES = [
  "PROTON_",
  "DXVK_",
  "VKD3D_",
  "MANGOHUD_",
  "GAMESCOPE_",
  "AMD_VULKAN_",
  "__GL_",
  "__NV_",
];

/**
 * The Proton tuning variables in `env`. `flatpak-spawn --host` starts from the desktop's
 * environment rather than Vortex's, so without forwarding these a Flatpak Vortex would drop
 * options such as `PROTON_LOG=1` that a native Vortex passes on.
 */
export function inheritedProtonTuning(
  env: Record<string, string | undefined>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        (TUNING_EXACT.has(entry[0]) ||
          TUNING_PREFIXES.some((prefix) => entry[0].startsWith(prefix))),
    ),
  );
}

const PREFIX_VERSION_PATTERN = /^CURRENT_PREFIX_VERSION\s*=\s*"([^"]+)"/m;

/** The prefix version a Proton launcher script creates, such as `10.1000-105`. */
export function protonPrefixVersion(protonScript: string): string | undefined {
  return PREFIX_VERSION_PATTERN.exec(protonScript)?.[1];
}

/** `[major, minor]` of a stock Proton prefix version such as `9.0-203`; undefined for GE builds. */
export function numericPrefixVersion(version: string): [number, number] | undefined {
  const match = /^(\d+)\.(\d+)-/.exec(version.trim());
  return match === null ? undefined : [Number(match[1]), Number(match[2])];
}

/**
 * Explains why the Proton at `protonPath` must not install into the prefix at `compatDataPath`,
 * or returns undefined when it is safe. Proton downgrades a prefix only when a game launches, so
 * running an older Proton's Wine against a prefix a newer one built can hang instead of failing.
 * GE-style versions can't be ordered, so they're never reported.
 *
 * Adapted from Amethyst Mod Manager (GPL-3.0), `prefix_downgrade_warning` in
 * src/Utils/wine/protontricks.py, https://github.com/ChrisDKN/Amethyst-Mod-Manager.
 */
export function prefixDowngradeWarning(
  protonScript: string,
  prefixVersion: string,
): string | undefined {
  const runtimeVersion = PREFIX_VERSION_PATTERN.exec(protonScript)?.[1];
  const built = prefixVersion.trim();
  if (runtimeVersion === undefined || built === "" || runtimeVersion === built) return undefined;
  const older = numericPrefixVersion(runtimeVersion);
  const newer = numericPrefixVersion(built);
  if (older === undefined || newer === undefined) return undefined;
  if (older[0] > newer[0] || (older[0] === newer[0] && older[1] >= newer[1])) return undefined;
  return (
    `This game's prefix was created by Proton ${newer[0]} (${built}), but Proton ${older[0]} ` +
    `(${runtimeVersion}) is selected. Proton only downgrades a prefix when the game launches, so ` +
    `installing into it now could hang. Launch the game once from Steam with Proton ${older[0]}, ` +
    `or select a newer Proton, then try again.`
  );
}

/** The `proton` launcher script of the Proton installed at `protonPath`. */
export function protonScriptPath(protonPath: string): string {
  return path.join(protonPath, "proton");
}

/**
 * Build the command to run an executable through Proton
 */
export function buildProtonCommand(
  protonPath: string,
  exePath: string,
  args: string[],
): { executable: string; args: string[] } {
  return {
    executable: path.join(protonPath, "proton"),
    args: ["run", exePath, ...args],
  };
}
