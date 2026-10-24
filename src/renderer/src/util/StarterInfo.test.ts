import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import PromiseBB from "bluebird";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { getGame } from "../extensions/gamemode_management/util/getGame";
import {
  makeApiHarness,
  makeStarterInfo,
  registerHarnessGame,
  resetHarnessRegistries,
} from "../test-utils/builders";
import type { IExtensionApi, IRunOptions } from "../types/IExtensionContext";
import type { IGame } from "../types/IGame";
import { MissingDependency, ProcessCanceled, UserCanceled } from "./CustomErrors";
import StarterInfo, { type IStarterInfo } from "./StarterInfo";
import type * as StoreLookup from "./storeLookup";

const launch = vi.hoisted(() => ({
  run: vi.fn(),
  exit: vi.fn(),
  hide: vi.fn(),
  show: vi.fn(),
  launched: vi.fn(),
  quit: vi.fn(),
}));
vi.mock("./gameLaunchAnalytics", () => ({
  emitGameLaunched: launch.launched,
  recordLaunchExit: launch.exit,
}));

vi.mock("./application", () => ({ getApplication: () => ({ quit: launch.quit }) }));
const stores = vi.hoisted(() => ({ steamExe: undefined as string | undefined }));
vi.mock("./storeLookup", async (original) => {
  const actual = await original<typeof StoreLookup>();
  return {
    ...actual,
    getGameStore: (...args: Parameters<typeof actual.getGameStore>) =>
      stores.steamExe !== undefined && args[1] === "steam"
        ? { getGameStorePath: () => Promise.resolve(stores.steamExe) }
        : actual.getGameStore(...args),
  };
});
vi.mock("../extensions/analytics/utils/modListSnapshot", () => ({
  emitModListSnapshot: vi.fn().mockResolvedValue(undefined),
}));

/** A v28 appinfo.vdf holding Halo MCC (976730) with its option2 launch entry only. */
const MCC_APPINFO = (() => {
  const text = (value: string) => Buffer.from(value + "\0", "utf8");
  const u32 = (value: number) => {
    const out = Buffer.alloc(4);
    out.writeUInt32LE(value);
    return out;
  };
  const body = Buffer.concat([
    Buffer.alloc(4 + 4 + 8 + 20 + 4 + 20),
    ...["appinfo", "config", "launch", "1"].flatMap((name) => [Buffer.from([0x00]), text(name)]),
    ...[
      ["executable", "mcc\\binaries\\win64\\mcc-win64-shipping.exe"],
      ["arguments", "-no-eac"],
      ["type", "option2"],
    ].flatMap(([name, value]) => [Buffer.from([0x01]), text(name), text(value)]),
    Buffer.from([0x08, 0x08, 0x08, 0x08, 0x08]),
  ]);
  return Buffer.concat([u32(0x07564428), u32(1), u32(976730), u32(body.length), body, u32(0)]);
})();

interface IStarterInternals {
  runDirectly: (
    info: IStarterInfo,
    api: IExtensionApi,
    onError: (...args: any[]) => void,
    onSpawned: () => void,
  ) => Promise<void>;
}
const run = (StarterInfo as unknown as IStarterInternals).runDirectly;
const originalProcess = process;
const originalApi = window.api;

beforeEach(() => {
  vi.stubGlobal("process", { ...originalProcess, platform: "linux" });
  launch.run.mockReset().mockResolvedValue(undefined);
  launch.exit.mockReset();
  launch.launched.mockReset();
  launch.quit.mockReset();
  launch.hide.mockReset().mockResolvedValue(undefined);
  launch.show.mockReset().mockResolvedValue(undefined);
  window.api = {
    ...originalApi,
    window: {
      ...originalApi.window,
      hide: launch.hide,
      show: launch.show,
      isVisible: async () => false,
    },
  };
});
afterEach(() => {
  resetHarnessRegistries();
  vi.unstubAllGlobals();
  window.api = originalApi;
});

function harness() {
  const h = makeApiHarness();
  const info = makeStarterInfo({
    exePath: "/games/stardew/Stardew Valley.exe",
    store: "steam",
    onStart: "hide_recover",
  });
  h.setRunProcess((options) => launch.run(h.api, info.exePath, info.commandLine, options));
  return { ...h, info, error: vi.fn(), spawned: vi.fn() };
}

test("API launch records original executable exit and restores a hidden window", async () => {
  const h = harness();
  launch.run.mockImplementation(async (_api, _exe, _args, options: IRunOptions) => {
    options.onSpawned?.(123);
    options.onExit?.(7, null);
  });
  await run(h.info, h.api, h.error, h.spawned);
  expect(h.spawned).toHaveBeenCalledOnce();
  expect(launch.hide).toHaveBeenCalledOnce();
  expect(launch.exit).toHaveBeenCalledWith(h.info.exePath, 7);
  expect(launch.show).toHaveBeenCalledOnce();
  expect(h.runExecutableCalls).toHaveLength(1);
});

for (const error of [new ProcessCanceled("cancelled"), new UserCanceled()]) {
  test(
    "API cancellation is handled without an error notification: " + error.constructor.name,
    async () => {
      const h = harness();
      launch.run.mockRejectedValue(error);
      await expect(run(h.info, h.api, h.error, h.spawned)).resolves.toBeUndefined();
      expect(h.error).not.toHaveBeenCalled();
      expect(launch.show).toHaveBeenCalledOnce();
    },
  );
}

test("API preparation errors use the ordinary launch error handler", async () => {
  const h = harness();
  const error = new Error("Selected Proton runtime is unavailable");
  launch.run.mockRejectedValue(error);
  await expect(run(h.info, h.api, h.error, h.spawned)).resolves.toBeUndefined();
  expect(h.error).toHaveBeenCalledWith("Failed to run tool", { executable: h.info.exePath, error });
  expect(launch.show).toHaveBeenCalledOnce();
});

test("API dependency errors retain the existing explanatory notification", async () => {
  const h = harness();
  launch.run.mockRejectedValue(new MissingDependency());
  await run(h.info, h.api, h.error, h.spawned);
  expect(h.error).toHaveBeenCalledWith(
    "Failed to run tool",
    expect.objectContaining({
      executable: h.info.exePath,
      message: expect.stringContaining("dependency is missing"),
    }),
    false,
  );
});

for (const platform of ["win32", "linux"] as const) {
  test(
    platform + ": ordinary executable launch keeps exit and window recovery handling",
    async () => {
      const h = harness();
      vi.stubGlobal("process", { ...originalProcess, platform });
      if (platform === "linux") h.info.exePath = "/games/stardew/StardewValley";
      h.setRunProcess(async (options) => {
        options.onSpawned?.(456);
        options.onExit?.(0, null);
      });
      // The API contract returns Bluebird; keep the control identical to production.
      const originalRun = h.api.runExecutable;
      h.api.runExecutable = (...args) => PromiseBB.resolve(originalRun(...args));
      await run(h.info, h.api, h.error, h.spawned);
      expect(h.runExecutableCalls).toHaveLength(1);
      expect(launch.run).not.toHaveBeenCalled();
      expect(launch.exit).toHaveBeenCalledWith(h.info.exePath, 0);
      expect(launch.show).toHaveBeenCalledOnce();
      expect(h.error).not.toHaveBeenCalled();
    },
  );
}

for (const mode of ["hide", "hide_recover", "close"] as const) {
  test(
    "public API launch preserves running state, analytics and " + mode + " behavior",
    async () => {
      const h = harness();
      registerHarnessGame(h.info.gameId);
      h.info.onStart = mode;
      h.info.detach = false;
      launch.run.mockImplementation(async (_api, _exe, _args, options: IRunOptions) => {
        expect(options.detach).toBe(mode === "close");
        options.onSpawned?.(123);
        options.onExit?.(0, null);
      });
      await StarterInfo.run(h.info, h.api, h.error);
      expect(h.dispatched).toContainEqual(
        expect.objectContaining({
          type: "SET_TOOL_RUNNING",
          payload: expect.objectContaining({
            exePath: h.info.exePath,
            exclusive: h.info.exclusive,
          }),
        }),
      );
      expect(launch.launched).toHaveBeenCalledWith(h.api, h.info);
      expect(launch.exit).toHaveBeenCalledWith(h.info.exePath, 0);
      expect(launch.hide).toHaveBeenCalledTimes(mode === "close" ? 0 : 1);
      expect(launch.show).toHaveBeenCalledTimes(mode === "hide_recover" ? 1 : 0);
      expect(launch.quit).toHaveBeenCalledTimes(mode === "close" ? 1 : 0);
      expect(h.error).not.toHaveBeenCalled();
    },
  );
}

for (const direct of [true, false]) {
  test(
    "a store-launched game " +
      (direct ? "deployed virtually starts directly" : "otherwise goes through its launcher"),
    async () => {
      const h = harness();
      registerHarnessGame(h.info.gameId);
      const game = getGame(h.info.gameId) as IGame;
      game.requiresLauncher = () => PromiseBB.resolve({ launcher: "steam" });
      (h.api as { ext: Record<string, unknown> }).ext = {
        ...h.api.ext,
        vfsLaunchesDirectly: (gameId: string) => direct && gameId === h.info.gameId,
      };
      const throughLauncher = vi
        .spyOn(
          StarterInfo as unknown as { runThroughLauncher: () => Promise<void> },
          "runThroughLauncher",
        )
        .mockResolvedValue(undefined);
      await StarterInfo.run(h.info, h.api, h.error);
      expect(throughLauncher).toHaveBeenCalledTimes(direct ? 0 : 1);
      expect(h.runExecutableCalls).toHaveLength(direct ? 1 : 0);
      expect(h.error).not.toHaveBeenCalled();
      delete game.requiresLauncher;
    },
  );
}

test("a virtually deployed game started directly runs the Steam launch option it asked for", async () => {
  const h = harness();
  registerHarnessGame(h.info.gameId);
  const game = getGame(h.info.gameId) as IGame;
  game.requiresLauncher = () =>
    PromiseBB.resolve({ launcher: "steam", addInfo: { appId: "976730", parameters: ["option2"] } });
  (h.api as { ext: Record<string, unknown> }).ext = {
    ...h.api.ext,
    vfsLaunchesDirectly: () => true,
  };
  // Halo MCC's "Anti-Cheat Disabled" entry, in Steam's v28 cache layout.
  const steam = fs.mkdtempSync(path.join(os.tmpdir(), "vortex-steam-"));
  fs.mkdirSync(path.join(steam, "appcache"));
  fs.writeFileSync(path.join(steam, "appcache", "appinfo.vdf"), MCC_APPINFO);
  stores.steamExe = path.join(steam, "steam.exe");
  const gamePath = path.join(steam, "steamapps", "common", "Halo The Master Chief Collection");
  h.setState((draft) => {
    draft.settings.gameMode.discovered[h.info.gameId] = { path: gamePath };
  });
  h.info.commandLine = ["-user"];
  try {
    await StarterInfo.run(h.info, h.api, h.error);
  } finally {
    stores.steamExe = undefined;
    delete game.requiresLauncher;
    fs.rmSync(steam, { recursive: true, force: true });
  }
  expect(h.runExecutableCalls).toHaveLength(1);
  expect(h.runExecutableCalls[0]).toMatchObject({
    executable: path.join(gamePath, "mcc\\binaries\\win64\\mcc-win64-shipping.exe"),
    args: ["-no-eac", "-user"],
    options: { gameId: h.info.gameId },
  });
  expect(h.error).not.toHaveBeenCalled();
});

test("a tool outside its game passes explicit game context to the shared API", async () => {
  const h = harness();
  registerHarnessGame(h.info.gameId);
  h.info.isGame = false;
  h.info.exePath = "/tools/xedit.exe";
  await StarterInfo.run(h.info, h.api, h.error);
  expect(h.runExecutableCalls).toHaveLength(1);
  expect(h.runExecutableCalls[0]).toMatchObject({
    executable: h.info.exePath,
    options: { gameId: h.info.gameId },
  });
  expect(h.error).not.toHaveBeenCalled();
});
