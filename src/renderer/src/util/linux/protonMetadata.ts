import * as fs from "node:fs/promises";
import * as path from "node:path";

import { parse, type KVBlock } from "@nexusmods/steam-kv-parser";

export interface IDependencyTargetInput {
  appId: string;
  steamPath: string;
  gamePath: string;
  compatDataPath: string;
  protonPath: string;
}

export interface IDependencyTarget {
  steamPath: string;
  gamePath: string;
  protonPath: string;
  compatDataPath: string;
  protonName: string;
  readOnlyRoots: string[];
  runtimePath?: string;
  runtimeWritePaths: string[];
}

export interface ICustomProtonName {
  name: string;
  path: string;
}

interface IRuntimeMetadata extends ICustomProtonName {
  appId?: string;
  compatDataPath?: string;
  commonPath?: string;
}

export interface IDependencyMetadataOptions {
  /** Effective additional roots must match the inner Protontricks environment. */
  customToolRoots?: string[];
}

function fail(message: string): never {
  throw new Error(`${message} Refresh Steam libraries and the Proton page, then retry.`);
}

function missing(error: unknown): boolean {
  return ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");
}

function child(parent: KVBlock, name: string) {
  const matches = parent.children.filter((entry) => entry.key.toLowerCase() === name.toLowerCase());
  if (matches.length > 1) fail(`Steam metadata has duplicate ${name} keys.`);
  return matches[0];
}

function block(parent: KVBlock, name: string): KVBlock | undefined {
  const entry = child(parent, name);
  return entry?.type === "block" ? entry : undefined;
}

function leaf(parent: KVBlock, name: string): string | undefined {
  const entry = child(parent, name);
  return entry?.type === "leaf" ? entry.value : undefined;
}

function required(parent: KVBlock, name: string): string {
  const value = leaf(parent, name);
  if (value === undefined || value.length === 0 || /[\r\n\0]/.test(value)) {
    fail(`Steam metadata has no valid ${name}. Repair its installation in Steam.`);
  }
  return value;
}

async function document(file: string, rootName: string): Promise<KVBlock> {
  const parsed = parse(await fs.readFile(file, "utf8"));
  if (parsed.key.toLowerCase() !== rootName.toLowerCase()) {
    fail(`Unexpected Steam metadata root in ${file}.`);
  }
  return parsed;
}

async function directory(input: string, purpose: string): Promise<string> {
  if (!path.isAbsolute(input)) fail(`${purpose} must be an absolute path.`);
  try {
    const canonical = await fs.realpath(input);
    if (!(await fs.stat(canonical)).isDirectory()) fail(`${purpose} is not a directory.`);
    return canonical;
  } catch (error) {
    throw Object.assign(
      new Error(
        `${purpose} is unavailable at ${input}. Check its filesystem access and initialize the game/runtime in Steam before retrying.`,
        { cause: error },
      ),
      {
        code: (error as NodeJS.ErrnoException).code,
      },
    );
  }
}

async function requireFile(file: string, purpose: string): Promise<void> {
  try {
    if ((await fs.stat(file)).isFile()) return;
  } catch (error) {
    if (!missing(error)) throw error;
  }
  fail(`${purpose} is missing at ${file}. Launch the selected Windows game/runtime once in Steam.`);
}

async function optionalDirectory(input: string): Promise<string | undefined> {
  try {
    return await directory(input, "Steam library");
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}

async function existingOrResolved(input: string): Promise<string> {
  try {
    return await fs.realpath(input);
  } catch (error) {
    if (missing(error)) return path.resolve(input);
    throw error;
  }
}

async function steamApps(root: string): Promise<string> {
  const children = (await fs.readdir(root, { withFileTypes: true })).filter(
    (entry) => entry.name.toLowerCase() === "steamapps",
  );
  if (children.length !== 1)
    fail(`Steam library ${root} needs one unambiguous steamapps directory.`);
  return directory(path.join(root, children[0].name), "Steam apps");
}

/** Follow the helper's steamapps/libraryfolders.vdf, not Vortex's config-first fallback. */
async function helperLibraries(steamPath: string): Promise<string[]> {
  const roots = new Set([steamPath]);
  let data: KVBlock;
  try {
    data = await document(
      path.join(await steamApps(steamPath), "libraryfolders.vdf"),
      "libraryfolders",
    );
  } catch (error) {
    if (missing(error)) return [...roots];
    throw error;
  }
  for (const entry of data.children) {
    if (!/^\d+$/.test(entry.key)) continue;
    const location = entry.type === "leaf" ? entry.value : required(entry, "path");
    if (!path.isAbsolute(location)) fail("Steam library metadata contains a relative path.");
    const canonical = await optionalDirectory(location);
    if (canonical !== undefined) roots.add(canonical);
  }
  return [...roots].sort();
}

async function officialMetadata(library: string): Promise<IRuntimeMetadata[]> {
  const apps = await steamApps(library);
  const result: IRuntimeMetadata[] = [];
  for (const name of (await fs.readdir(apps)).sort()) {
    if (!/^appmanifest_\d+\.acf$/.test(name)) continue;
    const data = await document(path.join(apps, name), "AppState");
    const appId = required(data, "appid");
    if (!/^[1-9][0-9]*$/.test(appId)) fail(`Invalid AppID in ${name}.`);
    const stateFlags = leaf(data, "stateflags");
    if (stateFlags !== undefined && (Number(stateFlags) & 1) !== 0) continue;
    const installDir = required(data, "installdir");
    // Refuse traversal instead of allowing a manifest to expand the eventual filesystem grant.
    if (installDir === "." || installDir === ".." || /[\\/]/.test(installDir)) {
      fail(`Unsupported install directory in ${name}. Repair its Steam app manifest.`);
    }
    result.push({
      appId,
      commonPath: await existingOrResolved(path.join(apps, "common")),
      compatDataPath: await existingOrResolved(path.join(apps, "compatdata", appId)),
      name: required(data, "name"),
      path: await existingOrResolved(path.join(apps, "common", installDir)),
    });
  }
  return result;
}

async function customManifest(file: string, root: string): Promise<ICustomProtonName | undefined> {
  const data = await document(file, "compatibilitytools");
  const tools = block(data, "compat_tools");
  // Protontricks takes only the first internal key, preserving its case.
  const first = tools?.children[0];
  if (first?.type !== "block" || first.key.length === 0 || /[\r\n\0]/.test(first.key)) {
    fail(`Custom Proton metadata has no first compatibility-tool entry: ${file}.`);
  }
  if (required(first, "from_oslist") !== "windows" || required(first, "to_oslist") !== "linux") {
    return undefined;
  }
  const installPath = required(first, "install_path");
  const target =
    installPath === "."
      ? path.dirname(file)
      : path.isAbsolute(installPath)
        ? installPath
        : path.resolve(root, installPath);
  return { name: first.key, path: await existingOrResolved(target) };
}

/** Use this metadata name for custom compatibility config keys; never guess from the folder. */
export async function readCustomProtonName(root: string): Promise<ICustomProtonName> {
  const canonical = await directory(root, "Custom Proton installation");
  const result = await customManifest(
    path.join(canonical, "compatibilitytool.vdf"),
    path.dirname(canonical),
  );
  if (result === undefined) fail("Selected custom tool is not a Windows-to-Linux Proton tool.");
  return result;
}

async function customMetadata(root: string): Promise<IRuntimeMetadata[]> {
  const canonical = await optionalDirectory(root);
  if (canonical === undefined) return [];
  const result: IRuntimeMetadata[] = [];
  for (const entry of (await fs.readdir(canonical, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (entry.name.endsWith(".vdf") && entry.isFile()) {
      const item = await customManifest(path.join(canonical, entry.name), canonical);
      if (item !== undefined) result.push(item);
    } else if (entry.isDirectory() || entry.isSymbolicLink()) {
      const file = path.join(canonical, entry.name, "compatibilitytool.vdf");
      try {
        const item = await customManifest(file, canonical);
        if (item !== undefined) result.push(item);
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
  }
  return result;
}

async function metadata(
  steamPath: string,
  libraries: string[],
  options: IDependencyMetadataOptions,
) {
  const extra = options.customToolRoots ?? [
    ...(process.platform === "linux"
      ? ["/usr/share/steam/compatibilitytools.d", "/usr/local/share/steam/compatibilitytools.d"]
      : []),
    ...(process.env.STEAM_EXTRA_COMPAT_TOOLS_PATHS?.split(path.delimiter).filter(Boolean) ?? []),
  ];
  return [
    ...(await Promise.all(libraries.map(officialMetadata))).flat(),
    ...(
      await Promise.all(
        [...new Set([...extra, path.join(steamPath, "compatibilitytools.d")])].map(customMetadata),
      )
    ).flat(),
  ];
}

/** Resolve the exact helper name and refuse any alternative metadata path it could select. */
export async function resolveExactRuntimeName(
  steamPath: string,
  protonPath: string,
  options: IDependencyMetadataOptions = {},
): Promise<string> {
  const steam = await directory(steamPath, "Steam client");
  const selected = await directory(protonPath, "Selected Proton");
  await requireFile(path.join(selected, "proton"), "Selected Proton launcher");
  const records = await metadata(steam, await helperLibraries(steam), options);
  const matching = records.filter((entry) => entry.path === selected);
  const names = [...new Set(matching.map((entry) => entry.name))];
  if (names.length !== 1)
    fail("Selected Proton has missing or ambiguous helper metadata. Reinstall that Proton tool.");
  const name = names[0];
  if (records.some((entry) => entry.name === name && entry.path !== selected)) {
    fail(
      `Proton name ${name} identifies multiple installations. Remove the duplicate or select a uniquely named tool.`,
    );
  }
  const selectedIds = new Set(
    matching.flatMap((entry) => (entry.appId === undefined ? [] : [entry.appId])),
  );
  if (
    records.some(
      (entry) =>
        entry.appId !== undefined && selectedIds.has(entry.appId) && entry.path !== selected,
    )
  ) {
    fail(
      "The selected Proton AppID has multiple installations. Remove its duplicate Steam installation before dependency setup.",
    );
  }
  return name;
}

function contains(parent: string, childPath: string): boolean {
  const relative = path.relative(parent, childPath);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

/** pressure-vessel locks its deployment and writes its own var cache. */
async function runtimeAccess(protonPath: string, libraries: string[], protectedPaths: string[]) {
  let manifest: KVBlock;
  try {
    manifest = await document(path.join(protonPath, "toolmanifest.vdf"), "manifest");
  } catch (error) {
    if (missing(error)) return { runtimeWritePaths: [] as string[] };
    throw error;
  }
  const appId = leaf(manifest, "require_tool_appid");
  if (appId === undefined) return { runtimeWritePaths: [] as string[] };
  if (!/^[1-9][0-9]*$/.test(appId)) fail("Selected Proton has an invalid Steam Runtime AppID.");
  const matches = (await Promise.all(libraries.map(officialMetadata)))
    .flat()
    .filter((entry) => entry.appId === appId);
  const paths = [...new Set(matches.map((entry) => entry.path))];
  if (paths.length !== 1) fail("Selected Proton needs one initialized Steam Runtime installation.");
  const runtimePath = await directory(paths[0], "Required Steam Runtime");
  if (
    matches.some(
      (entry) =>
        entry.commonPath === undefined ||
        runtimePath === entry.commonPath ||
        !contains(entry.commonPath, runtimePath),
    )
  )
    fail("Steam Runtime is redirected outside its declared library installation.");
  await requireFile(path.join(runtimePath, "toolmanifest.vdf"), "Steam Runtime tool manifest");
  await requireFile(path.join(runtimePath, "run"), "Steam Runtime launcher");
  if (protectedPaths.some((root) => contains(runtimePath, root) || contains(root, runtimePath))) {
    fail("The required Steam Runtime overlaps the game, prefix or Proton installation.");
  }
  const variable = await directory(path.join(runtimePath, "var"), "Steam Runtime cache");
  if (variable === runtimePath || !contains(runtimePath, variable))
    fail("Steam Runtime cache is redirected outside its installation.");
  const runtimeWritePaths = [variable];
  for (const entry of await fs.readdir(runtimePath, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(runtimePath, entry.name, "files", ".ref");
    try {
      const canonical = await fs.realpath(file);
      if (!contains(runtimePath, canonical) || !(await fs.stat(canonical)).isFile())
        fail("Steam Runtime deployment lock is redirected outside its installation.");
      runtimeWritePaths.push(canonical);
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
  return { runtimePath, runtimeWritePaths: [...new Set(runtimeWritePaths)].sort() };
}

export async function resolveDependencyTarget(
  input: IDependencyTargetInput,
  options: IDependencyMetadataOptions = {},
): Promise<IDependencyTarget> {
  if (!/^[1-9][0-9]*$/.test(input.appId)) fail("The selected game has an invalid Steam AppID.");
  const steamPath = await directory(input.steamPath, "Steam client");
  await directory(path.join(steamPath, "ubuntu12_32"), "Steam runtime bridge");
  const gamePath = await directory(input.gamePath, "Game installation");
  const protonPath = await directory(input.protonPath, "Selected Proton");
  const compatDataPath = await directory(input.compatDataPath, "Game compatdata");
  const prefix = await directory(path.join(compatDataPath, "pfx"), "Initialized Windows prefix");
  if (prefix !== path.join(compatDataPath, "pfx"))
    fail("The game prefix is redirected by a symlink. Select an unambiguous initialized prefix.");
  await requireFile(path.join(compatDataPath, "pfx.lock"), "Initialized game prefix lock");
  const libraries = await helperLibraries(steamPath);
  const games = (await Promise.all(libraries.map(officialMetadata)))
    .flat()
    .filter((entry) => entry.appId === input.appId);
  if (
    games.length === 0 ||
    games.some((entry) => entry.path !== gamePath || entry.compatDataPath !== compatDataPath)
  ) {
    fail(
      "The game AppID does not identify exactly the selected installation in the helper's libraries.",
    );
  }
  const readOnlyRoots = [...new Set([steamPath, ...libraries, protonPath])].sort();
  if ([gamePath, ...readOnlyRoots].some((root) => contains(compatDataPath, root))) {
    fail(
      "The requested writable prefix overlaps a Steam/game/runtime root. Correct the prefix path before retrying.",
    );
  }
  return {
    steamPath,
    gamePath,
    protonPath,
    compatDataPath,
    protonName: await resolveExactRuntimeName(steamPath, protonPath, options),
    readOnlyRoots,
    ...(await runtimeAccess(protonPath, libraries, [gamePath, compatDataPath, protonPath])),
  };
}
