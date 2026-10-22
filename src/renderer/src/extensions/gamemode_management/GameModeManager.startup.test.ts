import * as nodeFs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import type { IGame } from "../../types/IGame";
import { GameModeManager } from "./GameModeManager";

const fixture = vi.hoisted(() => ({ game: vi.fn() }));
vi.mock("../../util/getVortexPath", () => ({ default: () => "/tmp" }));
vi.mock("./util/getGame", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getGame: fixture.game,
}));
vi.mock("./util/detected_games/detectedGames", () => ({ requestDetectedGames: vi.fn() }));
afterEach(() => vi.unstubAllGlobals());

test.each([
  ["linux", "Game.exe", true],
  ["win32", "Game.exe", false],
  ["linux", "game.sh", false],
] as const)(
  "%s/%s setup keeps a discovered game intact while initial Steam scan is pending",
  async (platform, executable, waitForScan) => {
    vi.stubGlobal("process", { ...process, platform });
    const directory = await nodeFs.mkdtemp(path.join(os.tmpdir(), "vortex-initial-scan-"));
    let finishScan!: () => void;
    let scanned = false;
    const scan = new Promise<void>((resolve) => {
      finishScan = () => {
        scanned = true;
        resolve();
      };
    });
    const setup = vi.fn(() => Promise.resolve());
    const game = {
      id: "startup",
      name: "Startup",
      executable: () => executable,
      requiredFiles: [],
      getInstalledVersion: () => Promise.resolve("1.0"),
      setup,
    } as unknown as IGame;
    fixture.game.mockReturnValue(game);
    const state = {
      settings: { gameMode: { discovered: { startup: { path: directory, store: "steam" } } } },
    };
    const manager = new GameModeManager({} as any, [game], [], () => undefined);
    Object.assign(manager, { mKnownGameStores: [{ id: "steam", reloadGames: () => scan }] });
    manager.attachToStore({ getState: () => state, dispatch: vi.fn() } as any);
    const scanning = manager.startInitialScan();
    const preparing = manager.setupGameMode("startup");
    try {
      const first = await Promise.race([
        preparing.then(() => "prepared"),
        new Promise((resolve) => setTimeout(() => resolve("pending"), 40)),
      ]);
      expect(first).toBe(waitForScan ? "pending" : "prepared");
      expect(scanned).toBe(false);
      expect(setup).toHaveBeenCalledTimes(waitForScan ? 0 : 1);
    } finally {
      finishScan();
      await scanning;
      await preparing;
      await nodeFs.rm(directory, { recursive: true, force: true });
    }
    expect(setup).toHaveBeenCalledTimes(1);
  },
);
