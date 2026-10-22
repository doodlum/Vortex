import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import * as vm from "node:vm";

import IniParser, { IniFile, WinapiFormat } from "@nexusmods/ini-parser";
import { VortexGameId } from "@vortex/shared";
import Bluebird from "bluebird";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import * as invalidation from "../../../extensions/gamebryo-archive-invalidation/src/util/gameSupport";
import * as saves from "../../../extensions/gamebryo-savegame-management/src/util/gameSupport";
import * as fonts from "../../../extensions/gamebryo-test-settings/src/util/gameSupport";
import missingOblivionFonts from "../../../extensions/gamebryo-test-settings/src/util/missingOblivionFonts";
import StardewValleyGame from "../../../extensions/games/game-stardewvalley/src/game/StardewValleyGame";
import { onShowSMAPILog } from "../../../extensions/games/game-stardewvalley/src/ui/smapiLog";
import IniStructure from "../../../extensions/games/game-witcher3/src/iniParser";
import * as localSettings from "../../../extensions/local-gamesettings/src/util/gameSupport";
import * as folders from "../../../extensions/open-directory/src/gameSupport";
import * as plugins from "../src/extensions/gamebryo_plugin_management/util/gameSupport";
import { getGame } from "../src/extensions/gamemode_management/util/getGame";
import {
  registerModType,
  getModTypeExtensions,
} from "../src/extensions/gamemode_management/util/modTypeExtensions";
import { registerHarnessGame, resetHarnessRegistries } from "../src/test-utils/builders";
import { resolveCasePath } from "../src/util/casePath";
import { SetupError } from "../src/util/CustomErrors";
import {
  withGameUserPaths,
  resolveLegacyGamePath,
  gameUserPathNamespace,
  currentGameUserContext,
} from "../src/util/gameUserContext";
import { getGameUserPath, resolveGameWindowsPath } from "../src/util/getGameUserPath";
import local from "../src/util/local";
import { makeOverlayableDictionary } from "../src/util/util";

const fixture = vi.hoisted(() => ({
  documents: "",
  appData: "",
  localAppData: "",
  userData: "",
  lookup: vi.fn(),
  stat: vi.fn(),
}));
vi.mock("../src/util/getVortexPath", () => ({
  default: (name: "documents" | "appData" | "localAppData") => fixture[name],
}));
vi.mock("../src/util/storeLookup", () => ({ findGameEntry: fixture.lookup }));
vi.mock("../../../extensions/games/game-witcher3/src/util", () => ({
  forceRefresh: vi.fn(),
  getAllMods: vi.fn(),
  getManuallyAddedMods: vi.fn(),
}));
vi.mock("@nexusmods/vortex-api", async () => {
  const paths = await import("../src/util/getGameUserPath");
  const errors = await import("../src/util/CustomErrors");
  const helpers = await import("../src/util/util");
  const casePaths = await import("../src/util/casePath");
  return {
    log: vi.fn(),
    selectors: {
      discoveryByGame: (state: any, id: string) => state.settings.gameMode.discovered[id],
    },
    util: {
      getVortexPath: (name: "documents" | "appData" | "localAppData") => fixture[name],
      getGameUserPath: paths.getGameUserPath,
      SetupError: errors.SetupError,
      resolveCasePath: casePaths.resolveCasePath,
      makeOverlayableDictionary: helpers.makeOverlayableDictionary,
    },
    fs: {
      statAsync: fixture.stat,
      readFileAsync: Bluebird.method(fs.readFile),
      ensureDirWritableAsync: Bluebird.method((dir: string) => fs.mkdir(dir, { recursive: true })),
      writeFileAsync: Bluebird.method(fs.writeFile),
    },
  };
});

vi.mock("../../../extensions/games/game-stardewvalley/src/smapi/workflow", () => ({
  downloadAndInstallSMAPI: vi.fn(),
}));
vi.mock("../../../extensions/games/game-stardewvalley/src/smapi/selectors", () => ({
  findSMAPIMod: vi.fn(),
}));
vi.mock("../../../extensions/games/game-stardewvalley/src/smapi/lifecycle", () => ({
  deploySMAPI: vi.fn(),
}));

const originalProcess = process;
const require_ = createRequire(import.meta.url);
let directory: string;
let compatDataPath: string;
let discovery: { path: string; store: string };
let api: any;
let previousGameManager: any;
const gameRegistry = local<any>("gamemode-management", {
  gameModeManager: undefined,
  extensionGames: [],
  extensionStubs: [],
});
const prefixUser = () => path.join(compatDataPath, "pfx", "drive_c", "users", "steamuser");
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "vortex-game-user-consumers-"));
  fixture.documents = path.join(directory, "host", "Documents");
  fixture.appData = path.join(directory, "host", "Roaming");
  fixture.localAppData = path.join(directory, "host", "Local");
  fixture.userData = path.join(fixture.appData, "Vortex");
  compatDataPath = path.join(directory, "steamapps", "compatdata", "test");
  await fs.mkdir(prefixUser(), { recursive: true });
  await fs.writeFile(path.join(compatDataPath, "pfx", "system.reg"), "WINE REGISTRY Version 2\n");
  discovery = { path: path.join(directory, "game"), store: "steam" };
  const discovered = Object.fromEntries(
    [
      "skyrimse",
      "witcher3",
      "thesims4",
      "microsoftflightsimulator",
      "stardewvalley",
      "thesims3",
      "dragonage",
    ].map((id) => [id, discovery]),
  );
  const state = { settings: { gameMode: { discovered } } };
  api = {
    getState: () => state,
    store: { getState: () => state },
    showErrorNotification: vi.fn(),
    showDialog: vi.fn(),
    sendNotification: vi.fn(),
  };
  fixture.stat.mockReset().mockImplementation(Bluebird.method(fs.stat));
  fixture.lookup.mockReset().mockReturnValue({ usesProton: true, compatDataPath });
  for (const id of Object.keys(discovered)) registerHarnessGame(id);
  previousGameManager = gameRegistry.gameModeManager;
  gameRegistry.gameModeManager = { getDiscovery: (id: string) => discovered[id], gameStores: [] };
  const stardew = new StardewValleyGame({ api } as any);
  getGame("stardewvalley").executable = stardew.executable.bind(stardew);
  await fs.mkdir(discovery.path, { recursive: true });
  await fs.writeFile(
    path.join(discovery.path, "Stardew Valley.exe"),
    "Windows executable sentinel",
  );
  vi.stubGlobal("process", { ...originalProcess, platform: "linux" });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  gameRegistry.gameModeManager = previousGameManager;
  const modTypes = getModTypeExtensions();
  const ownedType = modTypes.findIndex((type) => type.typeId === "shared-prefix-test");
  if (ownedType !== -1) modTypes.splice(ownedType, 1);
  resetHarnessRegistries();
  await fs.rm(directory, { recursive: true, force: true });
});

test.each([
  ["archive invalidation", invalidation],
  ["save games", saves],
  ["font checks", fonts],
] as const)("%s agrees with the baker prefix INI", (_name, consumer) => {
  consumer.initGameSupport(api);
  expect(consumer.iniPath("skyrimse")).toBe(
    path.join(prefixUser(), "Documents", "My Games", "Skyrim Special Edition", "Skyrim.ini"),
  );
});

test("the real Witcher settings writer preserves host Documents", async () => {
  const hostSettings = path.join(fixture.documents, "The Witcher 3", "mods.settings");
  await fs.mkdir(path.dirname(hostSettings), { recursive: true });
  await fs.writeFile(hostSettings, "host sentinel");
  const writer = new IniStructure(api);
  await writer.writeToModSettings();
  expect(await fs.readFile(hostSettings, "utf8")).toBe("host sentinel");
  expect(
    await fs.readFile(
      path.join(prefixUser(), "Documents", "The Witcher 3", "mods.settings"),
      "utf8",
    ),
  ).toBe("");
});

function loadGame(relative: string, platform: NodeJS.Platform = "linux"): any {
  const filename = path.resolve(
    import.meta.dirname,
    "../../../extensions/games",
    relative,
    "src/index.js",
  );
  const module = { exports: {} };
  const disk = {
    statSync: fsSync.statSync,
    statAsync: Bluebird.method(fs.stat),
    ensureDirWritableAsync: Bluebird.method((dir: string) => fs.mkdir(dir, { recursive: true })),
    readFileSync: fsSync.readFileSync,
    readFileAsync: Bluebird.method(fs.readFile),
    writeFileAsync: Bluebird.method(fs.writeFile),
    ensureDirAsync: Bluebird.method((dir: string) => fs.mkdir(dir, { recursive: true })),
  };
  const vortexApi = {
    actions: {},
    fs: gameUserPathNamespace("fs", disk),
    log: vi.fn(),
    selectors: {
      discoveryByGame: (state: any, id: string) => state.settings.gameMode.discovered[id],
    },
    util: {
      getVortexPath: (name: "documents" | "appData" | "localAppData") => fixture[name],
      getGameUserPath,
      resolveGameWindowsPath,
      resolveCasePath,
      SetupError,
      makeOverlayableDictionary,
    },
  };
  const wrapper = vm.runInThisContext(
    "(function (module, exports, require, __dirname, process) {" +
      fsSync.readFileSync(filename, "utf8") +
      "\n})",
    { filename },
  );
  wrapper(
    module,
    module.exports,
    (name: string) =>
      name === "@nexusmods/vortex-api"
        ? vortexApi
        : name === "@nexusmods/ini-parser"
          ? { default: IniParser, WinapiFormat }
          : require_(name),
    path.dirname(filename),
    { platform, env: { LOCALAPPDATA: fixture.localAppData } },
  );
  let game: any;
  const context = new Proxy(
    {
      api,
      registerGame: (value: any) => {
        game = value;
        if (getGame(value.id) === undefined) registerHarnessGame(value.id);
        Object.assign(getGame(value.id), value);
      },
    },
    {
      get: (target, key) => (Reflect.has(target, key) ? Reflect.get(target, key) : vi.fn()),
    },
  );
  (module.exports as any).default(context);
  return game;
}

test("Sims setup edits prefix Options and creates prefix Resource.cfg, preserving host files", async () => {
  const base = (documents: string) => path.join(documents, "Electronic Arts", "The Sims 4");
  const hostOptions = path.join(base(fixture.documents), "Options.ini");
  const prefixOptions = path.join(base(path.join(prefixUser(), "Documents")), "Options.ini");
  for (const file of [hostOptions, prefixOptions]) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "[options]\nscriptmodsenabled=0\nmodsdisabled=1\n; retained\n");
  }
  const hostBytes = await fs.readFile(hostOptions);
  const game = loadGame("game-sims4");
  await game.setup(discovery);
  expect(await fs.readFile(hostOptions)).toEqual(hostBytes);
  expect(await fs.readFile(prefixOptions, "utf8")).toContain("scriptmodsenabled=1");
  expect(await fs.readFile(prefixOptions, "utf8")).toContain("modsdisabled=0");
  expect(await fs.readFile(prefixOptions, "utf8")).toContain("; retained");
  expect(game.queryModPath(discovery.path)).toBe(
    path.join(path.dirname(prefixOptions), "Mods", "Vortex Mods"),
  );
  expect(
    await fs.readFile(path.join(path.dirname(prefixOptions), "Mods", "Resource.cfg"), "utf8"),
  ).toContain("Priority 1337");
  await expect(fs.stat(path.join(path.dirname(hostOptions), "Mods"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("Flight Simulator resolves prefix AppData and Windows InstalledPackagesPath", async () => {
  const prefixAppData = path.join(prefixUser(), "AppData", "Roaming", "Microsoft Flight Simulator");
  const hostAppData = path.join(fixture.appData, "Microsoft Flight Simulator");
  await fs.mkdir(prefixAppData, { recursive: true });
  await fs.mkdir(hostAppData, { recursive: true });
  await fs.writeFile(
    path.join(prefixAppData, "UserCfg.opt"),
    'InstalledPackagesPath "C:\\Users\\steamuser\\AppData\\Roaming\\Microsoft Flight Simulator\\Packages"\n',
  );
  await fs.writeFile(
    path.join(hostAppData, "UserCfg.opt"),
    'InstalledPackagesPath "C:\\WrongHostPackages"\n',
  );
  const game = loadGame("game-microsoftflightsimulator");
  expect(game.queryModPath(discovery.path)).toBe(path.join(prefixAppData, "Packages", "Community"));
  expect(await fs.readFile(path.join(hostAppData, "UserCfg.opt"), "utf8")).toContain(
    "WrongHostPackages",
  );
});

test("local profile settings share the same prefix directory and fail closed on a lost identity", async () => {
  localSettings.initGameSupport(api);
  expect(localSettings.mygamesPath("skyrimse")).toBe(
    path.join(prefixUser(), "Documents", "My Games", "Skyrim Special Edition"),
  );
  fixture.lookup.mockImplementation(() => {
    throw new Error("Steam scan failed");
  });
  expect(() => localSettings.mygamesPath("skyrimse")).toThrow("Steam scan failed");
});

test("Windows Sims registry discovery remains available alongside Linux Steam discovery", () => {
  const windows = loadGame("game-sims4", "win32");
  expect(windows.queryPath).toBeTypeOf("function");
  expect(windows.queryArgs).toBeUndefined();
  expect(loadGame("game-sims4").queryArgs).toEqual({ steam: "1222670" });
});

test("Sims uses the physical case of existing prefix folders and Resource.cfg", async () => {
  const gameRoot = path.join(prefixUser(), "Documents", "electronic arts", "THE SIMS 4");
  const mods = path.join(gameRoot, "mods");
  await fs.mkdir(mods, { recursive: true });
  await fs.writeFile(
    path.join(gameRoot, "options.INI"),
    "[options]\nscriptmodsenabled=0\nmodsdisabled=1\n",
  );
  await fs.writeFile(path.join(mods, "resource.CFG"), "Priority 500\nPackedFile *.package\n");
  const game = loadGame("game-sims4");
  await game.setup(discovery);
  expect(game.queryModPath(discovery.path)).toBe(path.join(mods, "Vortex Mods"));
  expect(await fs.readFile(path.join(mods, "resource.CFG"), "utf8")).toContain("Priority 1337");
  expect(await fs.readdir(path.dirname(gameRoot))).toEqual(["THE SIMS 4"]);
});

test("Flight Simulator uses physical config and Community names", async () => {
  const appData = path.join(prefixUser(), "AppData", "Roaming", "microsoft flight simulator");
  const community = path.join(appData, "packages", "community");
  await fs.mkdir(community, { recursive: true });
  await fs.writeFile(
    path.join(appData, "usercfg.OPT"),
    'InstalledPackagesPath "C:\\Users\\steamuser\\AppData\\Roaming\\Microsoft Flight Simulator\\Packages"\n',
  );
  expect(loadGame("game-microsoftflightsimulator").queryModPath(discovery.path)).toBe(community);
});

test("a physically present Oblivion custom font is not offered for destructive repair", async () => {
  const physical = path.join(discovery.path, "data", "fonts", "CUSTOM.FNT");
  await fs.mkdir(path.dirname(physical), { recursive: true });
  await fs.writeFile(physical, "custom font");
  api.getState().settings.gameMode.discovered.oblivion = discovery;
  const ini = new IniFile({ Fonts: { sfontfile_1: "Data\\Fonts\\Custom.fnt" } });
  expect(await missingOblivionFonts(api.store, ini, "oblivion")).toEqual([]);
  expect(fixture.stat).toHaveBeenCalledWith(physical);
});

test("SMAPI log action reads the selected Proton log with its physical filename", async () => {
  const hostLog = path.join(fixture.appData, "StardewValley", "ErrorLogs", "SMAPI-crash.txt");
  const prefixLog = path.join(
    prefixUser(),
    "AppData",
    "Roaming",
    "stardewvalley",
    "errorlogs",
    "smapi-LATEST.TXT",
  );
  await fs.mkdir(path.dirname(hostLog), { recursive: true });
  await fs.mkdir(path.dirname(prefixLog), { recursive: true });
  await fs.writeFile(hostLog, "host log sentinel");
  await fs.writeFile(prefixLog, "selected Proton log");
  await onShowSMAPILog(api);
  expect(api.showDialog).toHaveBeenCalledOnce();
  expect(api.showDialog.mock.calls[0][2].text).toContain("selected Proton log");
  expect(api.showDialog.mock.calls[0][2].text).not.toContain("host log sentinel");
  expect(await fs.readFile(hostLog, "utf8")).toBe("host log sentinel");
});

test("native Stardew reads the host log without requiring a Steam prefix", async () => {
  await fs.unlink(path.join(discovery.path, "Stardew Valley.exe"));
  await fs.writeFile(path.join(discovery.path, "StardewValley"), "native executable sentinel");
  fixture.lookup.mockImplementation(() => {
    throw new Error("must not look up a native prefix");
  });
  const hostLog = path.join(fixture.appData, "StardewValley", "ErrorLogs", "SMAPI-latest.txt");
  await fs.mkdir(path.dirname(hostLog), { recursive: true });
  await fs.writeFile(hostLog, "native log");
  await onShowSMAPILog(api);
  expect(api.showDialog.mock.calls[0][2].text).toContain("native log");
  expect(fixture.lookup).not.toHaveBeenCalled();
});

test("SMAPI log action reports missing Proton identity before reading host logs", async () => {
  discovery.store = "gog";
  const hostLog = path.join(fixture.appData, "StardewValley", "ErrorLogs", "SMAPI-crash.txt");
  await fs.mkdir(path.dirname(hostLog), { recursive: true });
  await fs.writeFile(hostLog, "unrelated native log");
  await onShowSMAPILog(api);
  expect(api.showDialog).not.toHaveBeenCalled();
  expect(api.sendNotification).not.toHaveBeenCalled();
  expect(api.showErrorNotification).toHaveBeenCalledWith(
    "Failed to locate SMAPI logs",
    expect.any(Error),
    { allowReport: false },
  );
});

test("folder actions follow the current prefix, retaining Windows and native roots", async () => {
  folders.initGameSupport(api);
  const game = { id: "skyrimse" } as any;
  expect(folders.settingsPath(game)).toBe(
    path.join(prefixUser(), "Documents", "My Games", "Skyrim Special Edition"),
  );
  expect(folders.appDataPath(game)).toBe(
    path.join(prefixUser(), "AppData", "Local", "Skyrim Special Edition"),
  );
  const nextPrefix = path.join(directory, "another-library", "compatdata", "222");
  await fs.mkdir(path.join(nextPrefix, "pfx", "drive_c", "users", "steamuser"), {
    recursive: true,
  });
  await fs.writeFile(path.join(nextPrefix, "pfx", "system.reg"), "WINE REGISTRY Version 2\n");
  fixture.lookup.mockReturnValue({ usesProton: true, compatDataPath: nextPrefix });
  expect(folders.settingsPath(game)).toBe(
    path.join(
      nextPrefix,
      "pfx",
      "drive_c",
      "users",
      "steamuser",
      "Documents",
      "My Games",
      "Skyrim Special Edition",
    ),
  );
  discovery.store = "gog";
  expect(() => folders.settingsPath(game)).toThrow("Wine prefix is unavailable");
  Object.assign(discovery, { executable: "game.sh", store: "steam" });
  expect(folders.settingsPath(game)).toBe(
    path.join(fixture.documents, "My Games", "Skyrim Special Edition"),
  );
  vi.stubGlobal("process", { ...originalProcess, platform: "win32" });
  expect(folders.appDataPath(game)).toBe(path.join(fixture.localAppData, "Skyrim Special Edition"));
});

test("plugins.txt and LOOT's local data follow the game's Proton prefix", async () => {
  api.getState().session = { gameMode: { known: [] } };
  await plugins.initGameSupport(api);
  const prefixLocal = path.join(prefixUser(), "AppData", "local", "skyrim special edition");
  await fs.mkdir(prefixLocal, { recursive: true });
  expect(plugins.pluginPath("skyrimse")).toBe(prefixLocal);
  discovery.store = "gog";
  expect(() => plugins.pluginPath("skyrimse")).toThrow("Wine prefix is unavailable");
  vi.stubGlobal("process", { ...originalProcess, platform: "win32" });
  expect(plugins.pluginPath("skyrimse")).toBe(
    path.join(fixture.localAppData, "Skyrim Special Edition GOG"),
  );
});

test("plugins.txt follows the Wine prefix a non-Steam game is installed in", async () => {
  api.getState().session = { gameMode: { known: [] } };
  await plugins.initGameSupport(api);
  const prefix = path.join(directory, "Heroic", "Prefixes", "Skyrim");
  const user = path.join(prefix, "drive_c", "users", os.userInfo().username);
  discovery.path = path.join(prefix, "drive_c", "GOG Games", "Skyrim Special Edition");
  discovery.store = "gog";
  await fs.mkdir(discovery.path, { recursive: true });
  await fs.writeFile(path.join(prefix, "system.reg"), "WINE REGISTRY Version 2\n");
  const local = path.join(user, "AppData", "Local", "Skyrim Special Edition GOG");
  await fs.mkdir(local, { recursive: true });
  expect(plugins.pluginPath("skyrimse")).toBe(local);
});

test.each([
  ["steam", "Skyrim Special Edition"],
  ["gog", "Skyrim Special Edition GOG"],
  ["xbox", "Skyrim Special Edition MS"],
  ["epic", "Skyrim Special Edition EPIC"],
])("Windows folder actions retain the %s overlay", (store, folder) => {
  vi.stubGlobal("process", { ...originalProcess, platform: "win32" });
  discovery.store = store;
  folders.initGameSupport(api);
  const game = { id: "skyrimse" } as any;
  expect(folders.settingsPath(game)).toBe(path.join(fixture.documents, "My Games", folder));
  expect(folders.appDataPath(game)).toBe(path.join(fixture.localAppData, folder));
});

test("SMAPI refuses missing discovery even when the real game defaults to a native executable", async () => {
  delete api.getState().settings.gameMode.discovered.stardewvalley;
  expect(getGame("stardewvalley").executable(undefined)).toBe("StardewValley");
  const hostLog = path.join(fixture.appData, "StardewValley", "ErrorLogs", "SMAPI-crash.txt");
  await fs.mkdir(path.dirname(hostLog), { recursive: true });
  await fs.writeFile(hostLog, "unassociated host log");
  await onShowSMAPILog(api);
  expect(api.showDialog).not.toHaveBeenCalled();
  expect(api.sendNotification).not.toHaveBeenCalled();
  expect(api.showErrorNotification).toHaveBeenCalledWith(
    "Failed to locate SMAPI logs",
    expect.any(Error),
    { allowReport: false },
  );
});

test.skipIf(originalProcess.platform !== "linux")(
  "native SMAPI log filenames keep their case-sensitive selection",
  async () => {
    await fs.unlink(path.join(discovery.path, "Stardew Valley.exe"));
    await fs.writeFile(path.join(discovery.path, "StardewValley"), "native executable sentinel");
    const logs = path.join(fixture.appData, "StardewValley", "ErrorLogs");
    await fs.mkdir(logs, { recursive: true });
    await fs.writeFile(path.join(logs, "smapi-crash.txt"), "noncanonical crash sentinel");
    await fs.writeFile(path.join(logs, "SMAPI-latest.txt"), "canonical native latest");
    await onShowSMAPILog(api);
    expect(api.showDialog).toHaveBeenCalledOnce();
    expect(api.showDialog.mock.calls[0][2].text).toContain("canonical native latest");
    expect(api.showDialog.mock.calls[0][2].text).not.toContain("noncanonical crash sentinel");
  },
);

test("shared game context runs unchanged Sims 3 setup against its prefix", async () => {
  const hostMods = path.join(fixture.documents, "Electronic Arts", "The Sims 3", "Mods");
  await fs.mkdir(hostMods, { recursive: true });
  await fs.writeFile(path.join(hostMods, "Resource.cfg"), "host sentinel");
  const game = getGame(loadGame("game-sims3").id);
  await game.setup(discovery);
  const expectedMods = path.join(
    prefixUser(),
    "Documents",
    "Electronic Arts",
    "The Sims 3",
    "Mods",
  );
  expect(await fs.readFile(path.join(expectedMods, "Resource.cfg"), "utf8")).toContain(
    "Priority 500",
  );
  const modPath = game.queryModPath(discovery.path);
  expect(modPath).toBe(path.join(expectedMods, "Packages"));
  expect(await fs.readFile(path.join(hostMods, "Resource.cfg"), "utf8")).toBe("host sentinel");
  await expect(fs.stat(path.join(hostMods, "Packages"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("unchanged Dragon Age cached paths follow a replaced prefix during setup and queries", async () => {
  const game = getGame(loadGame("game-dragonage").id);
  const query = () => game.queryModPath(discovery.path);
  expect(query()).toBe(
    path.join(prefixUser(), "Documents", "BioWare", "Dragon Age", "packages", "core", "override"),
  );
  const next = path.join(directory, "replaced-prefix");
  const nextUser = path.join(next, "pfx", "drive_c", "users", "steamuser");
  await fs.mkdir(nextUser, { recursive: true });
  await fs.writeFile(path.join(next, "pfx", "system.reg"), "WINE REGISTRY Version 2\n");
  fixture.lookup.mockReturnValue({ usesProton: true, compatDataPath: next });
  expect(query()).toBe(
    path.join(nextUser, "Documents", "BioWare", "Dragon Age", "packages", "core", "override"),
  );
  await game.setup(discovery);
  expect(
    (
      await fs.stat(path.join(nextUser, "Documents", "BioWare", "Dragon Age", "AddIns"))
    ).isDirectory(),
  ).toBe(true);
  await expect(fs.stat(path.join(fixture.documents, "BioWare"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("shared Bluebird callbacks retain distinct game prefixes and preserve host userData", async () => {
  const secondGamePath = path.join(directory, "second-game");
  const secondPrefix = path.join(directory, "second-prefix");
  const secondUser = path.join(secondPrefix, "pfx", "drive_c", "users", "steamuser");
  await fs.mkdir(secondUser, { recursive: true });
  await fs.writeFile(path.join(secondPrefix, "pfx", "system.reg"), "WINE REGISTRY Version 2\n");
  fixture.lookup.mockImplementation((_stores: unknown, _key: unknown, gamePath: string) => ({
    usesProton: true,
    compatDataPath: gamePath === secondGamePath ? secondPrefix : compatDataPath,
  }));
  const disk = gameUserPathNamespace("fs", {
    ensureDirAsync: Bluebird.method((dir: string) => fs.mkdir(dir, { recursive: true })),
    writeFileAsync: Bluebird.method(fs.writeFile),
  });
  await fs.mkdir(fixture.appData, { recursive: true });
  const hostFile = path.join(fixture.appData, "scope.txt");
  await fs.writeFile(hostFile, "host sentinel");
  const shared = Bluebird.resolve();
  await Promise.all(
    [
      ["thesims3", discovery],
      ["dragonage", { path: secondGamePath, store: "steam" }],
    ].map(([id, selected]) =>
      withGameUserPaths(VortexGameId(id as string), selected as typeof discovery, () =>
        shared.then(async () => {
          expect(currentGameUserContext()?.gameId).toBe(id);
          await disk.ensureDirAsync(fixture.appData);
          await disk.writeFileAsync(hostFile, id as string);
          await disk.ensureDirAsync(path.join(fixture.userData, "Cache"));
        }),
      ),
    ),
  );
  expect(
    await fs.readFile(path.join(prefixUser(), "AppData", "Roaming", "scope.txt"), "utf8"),
  ).toBe("thesims3");
  expect(await fs.readFile(path.join(secondUser, "AppData", "Roaming", "scope.txt"), "utf8")).toBe(
    "dragonage",
  );
  expect(await fs.readFile(hostFile, "utf8")).toBe("host sentinel");
  expect((await fs.stat(path.join(fixture.userData, "Cache"))).isDirectory()).toBe(true);
  expect(currentGameUserContext()).toBeUndefined();
});

test("public mod-path and folder-detail callbacks translate cached legacy roots", () => {
  const game = getGame(loadGame("game-sims3").id);
  const cached = path.join(fixture.documents, "Legacy", "Secondary");
  registerModType(
    "shared-prefix-test",
    5,
    (id) => id === game.id,
    (owner) => {
      expect(currentGameUserContext()?.gameId).toBe(owner.id);
      return cached;
    },
    () => Bluebird.resolve(false),
  );
  Object.assign(game.details, { settingsPath: () => cached });
  expect(game.getModPaths(discovery.path)["shared-prefix-test"]).toBe(
    path.join(prefixUser(), "Documents", "Legacy", "Secondary"),
  );
  expect(game.details.settingsPath()).toBe(
    path.join(prefixUser(), "Documents", "Legacy", "Secondary"),
  );
  expect(currentGameUserContext()).toBeUndefined();
});

test("unavailable Proton ownership fails before unchanged setup creates host folders", async () => {
  const game = getGame(loadGame("game-sims3").id);
  const selected = { ...discovery, store: "gog" };
  expect(() => game.setup(selected)).toThrow("Wine prefix is unavailable");
  await expect(fs.stat(fixture.documents)).rejects.toMatchObject({ code: "ENOENT" });
});

test("an unchanged native Torchlight extension keeps its host Documents setup", async () => {
  const game = getGame(loadGame("game-torchlight2").id);
  const expected = path.join(fixture.documents, "My Games", "runic games", "torchlight 2", "mods");
  expect(game.executable(discovery.path)).toBe("ModLauncher.bin.x86");
  expect(game.queryModPath(discovery.path)).toBe(expected);
  await game.setup(discovery);
  expect((await fs.stat(expected)).isDirectory()).toBe(true);
  expect(fixture.lookup).not.toHaveBeenCalled();
});

test("Windows keeps unchanged extension callbacks and host paths", () => {
  vi.stubGlobal("process", { ...originalProcess, platform: "win32" });
  const original = loadGame("game-sims3", "win32");
  const game = getGame(original.id);
  expect(game.queryModPath).toBe(original.queryModPath);
  expect(game.setup).toBe(original.setup);
  expect(game.queryModPath(discovery.path)).toBe(
    path.join(fixture.documents, "Electronic Arts", "The Sims 3", "Mods", "Packages"),
  );
  expect(fixture.lookup).not.toHaveBeenCalled();
});

test("filesystem adaptation preserves payloads, options, descriptors and unscoped calls", () => {
  const calls: unknown[][] = [];
  const payload = Buffer.from(path.join(fixture.documents, "payload is not a path"));
  const options = { flag: "w" };
  const original = Object.freeze({
    writeFileAsync: (...args: unknown[]) => {
      calls.push(args);
      return payload;
    },
    marker: options,
  });
  const disk = gameUserPathNamespace("fs", original);
  expect(disk.marker).toBe(options);
  expect(disk.writeFileAsync).toBe(disk.writeFileAsync);
  const destination = pathToFileURL(path.join(fixture.appData, "saved.bin"));
  const result = withGameUserPaths(VortexGameId("thesims3"), discovery, () =>
    disk.writeFileAsync(destination, payload, options),
  );
  expect(result).toBe(payload);
  expect(fileURLToPath(calls[0][0] as URL)).toBe(
    path.join(prefixUser(), "AppData", "Roaming", "saved.bin"),
  );
  expect(calls[0][1]).toBe(payload);
  expect(calls[0][2]).toBe(options);
  withGameUserPaths(VortexGameId("thesims3"), discovery, () =>
    disk.writeFileAsync(42, payload, options),
  );
  expect(calls[1][0]).toBe(42);
  disk.writeFileAsync(destination, payload, options);
  expect(calls[2][0]).toBe(destination);
});

test("cached LocalLow paths and both copy arguments use the owning prefix", () => {
  const copy = vi.fn();
  const disk = gameUserPathNamespace("fs", { copyAsync: copy });
  const input = path.resolve(fixture.appData, "..", "LocalLow", "MCC", "Config", "ModManifest.txt");
  const output = path.join(fixture.documents, "copy.txt");
  const options = { overwrite: false };
  withGameUserPaths(VortexGameId("thesims3"), discovery, () =>
    disk.copyAsync(input, output, options),
  );
  expect(copy).toHaveBeenCalledWith(
    path.join(prefixUser(), "AppData", "LocalLow", "MCC", "Config", "ModManifest.txt"),
    path.join(prefixUser(), "Documents", "copy.txt"),
    options,
  );
});

test("game executable detection can read through the adapted Node filesystem", () => {
  const disk = gameUserPathNamespace("fs", fsSync);
  const game = getGame("thesims3");
  game.executable = () =>
    disk.existsSync(path.join(discovery.path, "Stardew Valley.exe")) ? "selected.exe" : "native.sh";
  const result = withGameUserPaths(VortexGameId(game.id), discovery, () =>
    resolveLegacyGamePath(path.join(fixture.documents, "selected.ini")),
  );
  expect(result).toBe(path.join(prefixUser(), "Documents", "selected.ini"));
});

test("executable metadata reads of user folders do not recurse through either public resolver", async () => {
  const disk = gameUserPathNamespace("fs", fsSync);
  const marker = path.join(fixture.documents, "build-marker");
  await fs.mkdir(fixture.documents, { recursive: true });
  await fs.writeFile(marker, "Windows build marker");
  const game = getGame("thesims3");
  game.executable = () => (disk.existsSync(marker) ? "selected.exe" : "native.sh");
  const expected = path.join(prefixUser(), "Documents", "settings.ini");
  expect(
    withGameUserPaths(VortexGameId(game.id), discovery, () =>
      resolveLegacyGamePath(path.join(fixture.documents, "settings.ini")),
    ),
  ).toBe(expected);
  expect(
    withGameUserPaths(VortexGameId(game.id), discovery, () =>
      getGameUserPath(game.id, discovery, "documents", "settings.ini"),
    ),
  ).toBe(expected);
});

test("explicit prefix file I/O stays stable when the Steam library is below host Documents", async () => {
  compatDataPath = path.join(fixture.documents, "SteamLibrary", "steamapps", "compatdata", "test");
  await fs.mkdir(path.join(prefixUser(), "Documents"), { recursive: true });
  await fs.writeFile(path.join(compatDataPath, "pfx", "system.reg"), "WINE REGISTRY Version 2\n");
  fixture.lookup.mockReturnValue({ usesProton: true, compatDataPath });
  const expected = getGameUserPath("thesims3", discovery, "documents", "settings.ini");
  const disk = gameUserPathNamespace("fs", fsSync);
  withGameUserPaths(VortexGameId("thesims3"), discovery, () => {
    disk.writeFileSync(expected, "selected prefix file");
    expect(disk.readFileSync(expected, "utf8")).toBe("selected prefix file");
  });
  expect(await fs.readFile(expected, "utf8")).toBe("selected prefix file");
  await expect(fs.stat(path.join(fixture.documents, "settings.ini"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("translated temporary-directory prefixes retain their final separator", async () => {
  await fs.mkdir(path.join(prefixUser(), "Documents"), { recursive: true });
  const disk = gameUserPathNamespace("fs", fsSync);
  const made = withGameUserPaths(VortexGameId("thesims3"), discovery, () =>
    disk.mkdtempSync(fixture.documents + path.sep),
  );
  expect(path.dirname(made)).toBe(path.join(prefixUser(), "Documents"));
});

test.each(["createWriteStream", "WriteStream"])(
  "%s uses its supplied fd without resolving an ignored game path",
  async (name) => {
    const filename = path.join(directory, "descriptor.txt");
    const descriptor = fsSync.openSync(filename, "w");
    const disk = gameUserPathNamespace("fs", fsSync);
    fixture.lookup.mockReturnValue({
      usesProton: true,
      compatDataPath: path.join(directory, "unavailable-prefix"),
    });
    let stream: fsSync.WriteStream | undefined;
    try {
      stream = withGameUserPaths(VortexGameId("thesims3"), discovery, () =>
        name === "WriteStream"
          ? (Reflect.construct(disk.WriteStream, [
              path.join(fixture.documents, "ignored.txt"),
              { fd: descriptor, autoClose: false },
            ]) as fsSync.WriteStream)
          : disk.createWriteStream(path.join(fixture.documents, "ignored.txt"), {
              fd: descriptor,
              autoClose: false,
            }),
      );
      await new Promise<void>((resolve, reject) => {
        stream.on("finish", resolve).on("error", reject);
        stream.end("descriptor payload");
      });
    } finally {
      fsSync.closeSync(descriptor);
    }
    expect(await fs.readFile(filename, "utf8")).toBe("descriptor payload");
    await expect(fs.stat(path.join(fixture.documents, "ignored.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);
