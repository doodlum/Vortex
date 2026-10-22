import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, expect, test, vi } from "vitest";

import type { IDiscoveryResult } from "../../extensions/gamemode_management/types/IDiscoveryResult";
import { iniFiles } from "../../extensions/ini_prep/gameSupport";
import { getIniFilePath } from "../../extensions/installer_fomod_shared/utils/gameSupport";
import { registerHarnessGame, resetHarnessRegistries } from "../../test-utils/builders";
import { GameEntryNotFound } from "../../types/IGameStore";
import { MissingInterpreter } from "../CustomErrors";
import { getGameUserPath, resolveGameWindowsPath } from "../getGameUserPath";
import { resolveGameDocumentsPaths } from "./gameDocuments";

const fixture = vi.hoisted(() => ({ documents: "", lookup: vi.fn() }));
vi.mock("../getVortexPath", () => ({
  default: (name: string) => (name === "documents" ? fixture.documents : ""),
}));
vi.mock("../storeLookup", () => ({ findGameEntry: fixture.lookup }));
const originalProcess = process;
let directory: string;
let compatDataPath: string;
let discovery: IDiscoveryResult;
const configRelative = path.join("My Games", "Skyrim Special Edition", "Skyrim.ini");
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "vortex-game-documents-"));
  fixture.documents = path.join(directory, "Documents");
  compatDataPath = path.join(directory, "steamapps", "compatdata", "489830");
  await fs.mkdir(path.join(compatDataPath, "pfx", "drive_c", "users", "steamuser"), {
    recursive: true,
  });
  await fs.writeFile(path.join(compatDataPath, "pfx", "system.reg"), "WINE REGISTRY Version 2\n");
  fixture.lookup.mockReset().mockReturnValue({ usesProton: true, compatDataPath });
  discovery = { path: path.join(directory, "game"), store: "steam" };
  registerHarnessGame("skyrimse");
  vi.stubGlobal("process", { ...originalProcess, platform: "linux" });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  resetHarnessRegistries();
  await fs.rm(directory, { recursive: true, force: true });
});
const hostFile = () => path.join(fixture.documents, configRelative);
const prefixFile = () =>
  path.join(compatDataPath, "pfx", "drive_c", "users", "steamuser", "Documents", configRelative);

test("redirects only Documents descendants, preserving their physical spelling", async () => {
  const gameIni = path.join(discovery.path!, "Morrowind.ini");
  expect(await resolveGameDocumentsPaths("skyrimse", discovery, [hostFile(), gameIni])).toEqual([
    prefixFile(),
    gameIni,
  ]);
  expect(fixture.lookup).toHaveBeenCalledWith(expect.any(Array), "path", discovery.path, "steam");
});
test("INI baking and FOMOD path builders select the same Proton Documents file", async () => {
  expect(await iniFiles("skyrimse", discovery)).toContain(prefixFile());
  expect(await getIniFilePath("skyrimse", discovery)).toBe(prefixFile());
});
test("keeps Documents siblings and game-directory INIs outside the prefix", async () => {
  const files = [
    path.join(directory, "DocumentsBackup", "file.ini"),
    path.join(discovery.path!, "file.ini"),
  ];
  expect(await resolveGameDocumentsPaths("skyrimse", discovery, files)).toEqual(files);
  expect(fixture.lookup).not.toHaveBeenCalled();
});
test("a native Linux game ignores old compatdata", async () => {
  registerHarnessGame("native");
  discovery = { ...discovery, executable: "game.sh" };
  expect(await resolveGameDocumentsPaths("native", discovery, [hostFile()])).toEqual([hostFile()]);
  expect(fixture.lookup).not.toHaveBeenCalled();
});
test("Windows keeps its native Documents path without a store lookup", async () => {
  vi.stubGlobal("process", { ...originalProcess, platform: "win32" });
  expect(await resolveGameDocumentsPaths("skyrimse", discovery, [hostFile()])).toEqual([
    hostFile(),
  ]);
  expect(fixture.lookup).not.toHaveBeenCalled();
});
test("missing Steam identity reports setup and preserves host files", async () => {
  await fs.mkdir(path.dirname(hostFile()), { recursive: true });
  await fs.writeFile(hostFile(), "host sentinel");
  fixture.lookup.mockImplementation(() => {
    throw new GameEntryNotFound(discovery.path!, "steam");
  });
  await expect(resolveGameDocumentsPaths("skyrimse", discovery, [hostFile()])).rejects.toThrow(
    MissingInterpreter,
  );
  expect(await fs.readFile(hostFile(), "utf8")).toBe("host sentinel");
});
test("a stale or uninitialized Proton prefix is not created implicitly", async () => {
  await fs.rm(path.join(compatDataPath, "pfx"), { recursive: true });
  await expect(resolveGameDocumentsPaths("skyrimse", discovery, [hostFile()])).rejects.toThrow(
    /launch the game in Steam/i,
  );
  await expect(fs.stat(path.join(compatDataPath, "pfx"))).rejects.toMatchObject({ code: "ENOENT" });
});
test("a Windows game without Proton does not fall back to host Documents", async () => {
  fixture.lookup.mockReturnValue({ usesProton: false, compatDataPath });
  await expect(resolveGameDocumentsPaths("skyrimse", discovery, [hostFile()])).rejects.toThrow(
    MissingInterpreter,
  );
});
test("unexpected discovery failures are preserved", async () => {
  const error = Object.assign(new Error("denied"), { code: "EACCES" });
  fixture.lookup.mockImplementation(() => {
    throw error;
  });
  await expect(resolveGameDocumentsPaths("skyrimse", discovery, [hostFile()])).rejects.toBe(error);
});

test("keeps a game-directory INI when the game is installed under Documents", async () => {
  discovery = { ...discovery, path: path.join(fixture.documents, "Games", "Morrowind") };
  registerHarnessGame("morrowind");
  expect(await iniFiles("morrowind", discovery)).toEqual([
    path.join(discovery.path!, "Morrowind.ini"),
  ]);
  expect(fixture.lookup).not.toHaveBeenCalled();
});
test("refuses an empty pfx rather than creating a Windows user tree", async () => {
  await fs.rm(path.join(compatDataPath, "pfx"), { recursive: true });
  await fs.mkdir(path.join(compatDataPath, "pfx"));
  await expect(resolveGameDocumentsPaths("skyrimse", discovery, [hostFile()])).rejects.toThrow(
    MissingInterpreter,
  );
  expect(await fs.readdir(path.join(compatDataPath, "pfx"))).toEqual([]);
});

test("resolves each Windows user folder without modifying the host path service", () => {
  const user = path.join(compatDataPath, "pfx", "drive_c", "users", "steamuser");
  expect(getGameUserPath("skyrimse", discovery, "documents")).toBe(path.join(user, "Documents"));
  expect(getGameUserPath("skyrimse", discovery, "appData")).toBe(
    path.join(user, "AppData", "Roaming"),
  );
  expect(getGameUserPath("skyrimse", discovery, "localAppData")).toBe(
    path.join(user, "AppData", "Local"),
  );
});

test("maps a configured Windows drive path using the prefix's physical directory case", async () => {
  const packages = path.join(
    compatDataPath,
    "pfx",
    "drive_c",
    "users",
    "steamuser",
    "AppData",
    "Roaming",
    "Packages",
  );
  await fs.mkdir(packages, { recursive: true });
  expect(
    resolveGameWindowsPath(
      "skyrimse",
      discovery,
      "C:\\Users\\steamuser\\AppData\\Roaming\\Packages",
    ),
  ).toBe(packages);
  expect(() => resolveGameWindowsPath("skyrimse", discovery, "Packages")).toThrow(
    /absolute drive path/,
  );
});

test("user subpaths preserve existing Windows directory and filename case", async () => {
  const file = path.join(
    compatDataPath,
    "pfx",
    "drive_c",
    "users",
    "steamuser",
    "Documents",
    "my games",
    "Skyrim Special Edition",
    "skyrim.INI",
  );
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "prefix sentinel");
  expect(
    getGameUserPath(
      "skyrimse",
      discovery,
      "documents",
      "My Games",
      "Skyrim Special Edition",
      "Skyrim.ini",
    ),
  ).toBe(file);
  expect(await resolveGameDocumentsPaths("skyrimse", discovery, [hostFile()])).toEqual([file]);
  expect(() => getGameUserPath("skyrimse", discovery, "documents", "..", "escape")).toThrow(
    /inside/,
  );
});
