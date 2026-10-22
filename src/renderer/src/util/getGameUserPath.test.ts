import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { registerHarnessGame, resetHarnessRegistries } from "../test-utils/builders";
import { MissingInterpreter } from "./CustomErrors";
import { getGameUserPath } from "./getGameUserPath";
import type { ISteamEntry } from "./Steam";

const fixture = vi.hoisted(() => ({ entries: [] as ISteamEntry[], scans: vi.fn(), documents: "" }));
vi.mock("../extensions/gamemode_management/util/gameRegistry", async (original) => ({
  ...(await original<object>()),
  getGameStoresSafe: () => [
    {
      id: "steam",
      allGames: fixture.scans,
      snapshot: () => ({ entries: fixture.entries, isInstalled: true }),
    },
  ],
}));
vi.mock("./getVortexPath", () => ({ default: () => fixture.documents }));
const originalProcess = process;
let directory: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "vortex-prefix-identity-"));
  fixture.documents = path.join(directory, "host-documents");
  fixture.entries = [];
  fixture.scans.mockReset();
  registerHarnessGame("selected");
  vi.stubGlobal("process", { ...originalProcess, platform: "linux" });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  resetHarnessRegistries();
  await fs.rm(directory, { recursive: true, force: true });
});
async function entry(id: string, gamePath: string): Promise<ISteamEntry> {
  const compatDataPath = path.join(directory, "library-" + id, "steamapps", "compatdata", id);
  await fs.mkdir(path.join(compatDataPath, "pfx", "drive_c", "users", "steamuser"), {
    recursive: true,
  });
  await fs.writeFile(path.join(compatDataPath, "pfx", "system.reg"), "WINE REGISTRY Version 2\n");
  return { appid: id, name: id, gamePath, gameStoreId: "steam", usesProton: true, compatDataPath };
}

test("the real Steam snapshot selects the associated installation's prefix across libraries", async () => {
  fixture.entries = [
    await entry("111", path.join(directory, "OtherGame")),
    await entry("222", path.join(directory, "SelectedCase")),
  ];
  const selected = fixture.entries[1];
  expect(
    getGameUserPath("selected", { path: selected.gamePath, store: "steam" }, "documents"),
  ).toBe(path.join(selected.compatDataPath!, "pfx", "drive_c", "users", "steamuser", "Documents"));
  expect(fixture.scans).not.toHaveBeenCalled();
});

test("an empty snapshot fails closed and never starts a discovery scan", () => {
  expect(() =>
    getGameUserPath(
      "selected",
      { path: path.join(directory, "SelectedCase"), store: "steam" },
      "documents",
    ),
  ).toThrow(MissingInterpreter);
  expect(fixture.scans).not.toHaveBeenCalled();
});

test("Linux installation identity keeps physical path case", async () => {
  fixture.entries = [await entry("222", path.join(directory, "SelectedCase"))];
  expect(() =>
    getGameUserPath(
      "selected",
      { path: path.join(directory, "selectedcase"), store: "steam" },
      "documents",
    ),
  ).toThrow(MissingInterpreter);
});

test("a known Windows game in another store does not edit host Documents", () => {
  expect(() =>
    getGameUserPath(
      "selected",
      { path: path.join(directory, "SelectedCase"), store: "gog" },
      "documents",
    ),
  ).toThrow(MissingInterpreter);
});

async function winePrefix(user: string | undefined): Promise<{ prefix: string; game: string }> {
  const prefix = path.join(directory, "Heroic", "Prefixes", "New Vegas");
  const game = path.join(prefix, "drive_c", "GOG Games", "Fallout New Vegas");
  await fs.mkdir(game, { recursive: true });
  if (user !== undefined)
    await fs.mkdir(path.join(prefix, "drive_c", "users", user), { recursive: true });
  await fs.writeFile(path.join(prefix, "system.reg"), "WINE REGISTRY Version 2\n");
  return { prefix, game };
}

test("a game installed inside a Wine prefix uses that prefix's account for this user", async () => {
  const { prefix, game } = await winePrefix(os.userInfo().username);
  expect(getGameUserPath("selected", { path: game, store: "gog" }, "documents", "My Games")).toBe(
    path.join(prefix, "drive_c", "users", os.userInfo().username, "Documents", "My Games"),
  );
});

test("a Wine prefix without this user's account fails closed", async () => {
  const { game } = await winePrefix(undefined);
  expect(() => getGameUserPath("selected", { path: game, store: "gog" }, "documents")).toThrow(
    MissingInterpreter,
  );
});

test("a Steam game never falls back to a containing Wine prefix", async () => {
  const { game } = await winePrefix(os.userInfo().username);
  expect(() => getGameUserPath("selected", { path: game, store: "steam" }, "documents")).toThrow(
    MissingInterpreter,
  );
  expect(fixture.scans).not.toHaveBeenCalled();
});

test("a native Linux executable retains its host Documents directory", () => {
  expect(
    getGameUserPath(
      "selected",
      { path: path.join(directory, "SelectedCase"), executable: "game.sh", store: "steam" },
      "documents",
    ),
  ).toBe(fixture.documents);
  expect(fixture.scans).not.toHaveBeenCalled();
});

test("Windows retains host user paths even before a Steam snapshot exists", () => {
  vi.stubGlobal("process", { ...originalProcess, platform: "win32" });
  expect(getGameUserPath("selected", undefined, "documents", "My Games")).toBe(
    path.join(fixture.documents, "My Games"),
  );
  expect(fixture.scans).not.toHaveBeenCalled();
});

test("all prefix user-folder roots and final subpaths keep their physical spelling", async () => {
  fixture.entries = [await entry("222", path.join(directory, "SelectedCase"))];
  const selected = fixture.entries[0];
  const user = path.join(selected.compatDataPath!, "pfx", "drive_c", "users", "steamuser");
  const discovery = { path: selected.gamePath, store: "steam" };
  for (const [name, parts] of [
    ["documents", ["documents", "my games"]],
    ["appData", ["appdata", "roaming", "my games"]],
    ["localAppData", ["appdata", "local", "my games"]],
    ["localLowAppData", ["appdata", "locallow", "my games"]],
  ] as const) {
    const physical = path.join(user, ...parts);
    await fs.mkdir(physical, { recursive: true });
    expect(getGameUserPath("selected", discovery, name, "My Games")).toBe(physical);
  }
});
