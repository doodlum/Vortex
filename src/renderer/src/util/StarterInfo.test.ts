import PromiseBB from "bluebird";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import ProcessMonitor from "../extensions/gamemode_management/util/ProcessMonitor";
import type { IProcessInfo } from "../extensions/gamemode_management/util/processProvider";
import { isExeRunning, makeExeId, sessionReducer } from "../reducers/session";
import {
  makeApiHarness,
  makeGameStored,
  makeProfile,
  makeStarterInfo,
  registerHarnessGame,
  resetHarnessRegistries,
} from "../test-utils/builders";
import type { IExtensionApi, IRunOptions } from "../types/IExtensionContext";
import { MissingDependency, ProcessCanceled, UserCanceled } from "./CustomErrors";
import StarterInfo, { type IStarterInfo } from "./StarterInfo";

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
vi.mock("../extensions/analytics/utils/modListSnapshot", () => ({
  emitModListSnapshot: vi.fn().mockResolvedValue(undefined),
}));

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
  vi.useRealTimers();
  vi.unstubAllEnvs();
  resetHarnessRegistries();
  vi.unstubAllGlobals();
  window.api = originalApi;
});

test("Flatpak keeps a launched native tool visible to the host monitor until its process exits", async () => {
  vi.useFakeTimers();
  vi.stubEnv("IS_FLATPAK", "true");
  const profile = makeProfile();
  const info = makeStarterInfo({
    isGame: false,
    exePath: "/tools/native-editor",
    exclusive: true,
    onStart: undefined,
  });
  registerHarnessGame(info.gameId);
  const h = makeApiHarness(
    {
      profiles: { [profile.id]: profile },
      activeProfileId: profile.id,
      knownGames: [makeGameStored()],
      discovered: { [info.gameId]: { path: "/games/test" } },
    },
    [{ path: ["session", "base"], reducer: sessionReducer }],
  );
  h.setState((draft) => {
    const discovery = draft.settings.gameMode.discovered[info.gameId];
    discovery.executable = "SkyrimSE.exe";
    discovery.tools = {
      native: {
        id: "native",
        name: "Native editor",
        path: info.exePath,
        executable: () => "native-editor",
        requiredFiles: [],
        hidden: false,
        custom: true,
        exclusive: true,
      },
    };
  });
  let processes: IProcessInfo[] = [
    { pid: 7001, ppid: 1, name: "native-editor", path: info.exePath },
  ];
  const monitor = new ProcessMonitor(h.api, {
    foreignNamespace: true,
    list: async () => processes,
  }) as unknown as { doCheck(): Promise<void> };
  let finish: () => void;
  const lifetime = new Promise<void>((resolve) => {
    finish = resolve;
  });
  h.setRunProcess(async (options) => {
    options.onSpawned?.(123);
    await lifetime;
    options.onExit?.(0, null);
  });
  const onError = vi.fn();
  const launching = StarterInfo.run(info, h.api, onError);
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(isExeRunning(h.api.getState().session.base.toolsRunning, info.exePath)).toBe(true);
    await vi.advanceTimersByTimeAsync(3000);
    await monitor.doCheck();
    expect(h.api.getState().session.base.toolsRunning[makeExeId(info.exePath)]).toMatchObject({
      pid: 7001,
      exclusive: true,
    });
    processes = [];
    await monitor.doCheck();
    expect(isExeRunning(h.api.getState().session.base.toolsRunning, info.exePath)).toBe(false);
    expect(onError).not.toHaveBeenCalled();
  } finally {
    finish!();
    await launching;
  }
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
