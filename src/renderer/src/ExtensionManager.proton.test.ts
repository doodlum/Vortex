import childProcess from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";

import PromiseBB from "bluebird";
import { beforeEach, afterEach, expect, test, vi } from "vitest";

import ExtensionManager from "./ExtensionManager";
import {
  makeApiHarness,
  makeStarterInfo,
  registerHarnessGame,
  resetHarnessRegistries,
} from "./test-utils/builders";
import type { IRegisteredExtension } from "./types/extensions";
import type { IRunParameters } from "./types/IExtensionContext";
import { GameStoreNotFound } from "./types/IGameStore";
import { MissingInterpreter } from "./util/CustomErrors";
import StarterInfo from "./util/StarterInfo";

const launch = vi.hoisted(() => ({
  store: vi.fn(),
  games: vi.fn(),
  proton: vi.fn(),
  spawn: vi.fn(),
}));
vi.mock("./util/storeLookup", () => ({ getGameStore: launch.store }));
vi.mock("./logging", () => ({ log: vi.fn() }));
vi.mock("./IPCDownloadAdapter", () => ({ IPCDownloadAdapter: class IPCDownloadAdapter {} }));
vi.mock("./StyleManager", () => ({ default: class StyleManager {} }));

const originalProcess = process;
interface ManagerInternals {
  prepareExtensions(): IRegisteredExtension[];
  mInterpreters: Record<string, (input: IRunParameters) => IRunParameters>;
  mStartHooks: Array<{
    id: string;
    priority: number;
    hook: (input: IRunParameters) => PromiseBB<IRunParameters>;
  }>;
}
beforeEach(() => {
  vi.stubGlobal("process", { ...originalProcess, platform: "linux" });
  vi.spyOn(
    ExtensionManager.prototype as unknown as ManagerInternals,
    "prepareExtensions",
  ).mockReturnValue([]);
  launch.games
    .mockReset()
    .mockResolvedValue([{ gamePath: "/games/stardew", usesProton: true, appid: "413150" }]);
  launch.proton.mockReset().mockResolvedValue(undefined);
  launch.store
    .mockReset()
    .mockReturnValue({ allGames: launch.games, runToolWithProton: launch.proton });
  vi.spyOn(childProcess, "spawn").mockImplementation(launch.spawn);
  syncBuiltinESMExports();
  launch.spawn.mockReset().mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { pid: 314, exitCode: null, unref: vi.fn() });
    setImmediate(() => child.emit("close", 0, null));
    return child;
  });
});
afterEach(() => {
  resetHarnessRegistries();
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  vi.unstubAllGlobals();
});

function harness() {
  const h = makeApiHarness();
  const manager = new ExtensionManager({}, h.api.events);
  const api = manager.getApi();
  api.store = h.api.store;
  api.getState = h.api.getState;
  return { api, internals: manager as unknown as ManagerInternals };
}

for (const condition of [
  "missing-store",
  "disabled-store",
  "empty-snapshot",
  "native-build",
  "lookup-error",
  "unassociated",
] as const) {
  test("extension API refuses raw Windows spawn after " + condition, async () => {
    const { api } = harness();
    if (condition === "missing-store") launch.store.mockReturnValue(undefined);
    if (condition === "disabled-store")
      launch.store.mockImplementation(() => {
        throw new GameStoreNotFound("steam");
      });
    if (condition === "empty-snapshot") launch.games.mockResolvedValue([]);
    if (condition === "native-build")
      launch.games.mockResolvedValue([
        { gamePath: "/games/stardew", usesProton: false, appid: "413150" },
      ]);
    const failure = new Error("Steam snapshot failed");
    if (condition === "lookup-error") launch.games.mockRejectedValue(failure);
    const result = api.runExecutable(
      condition === "unassociated" ? "/tools/orphan.exe" : "/games/stardew/tool.exe",
      [],
      {},
    );
    if (condition === "lookup-error") await expect(result).rejects.toBe(failure);
    else await expect(result).rejects.toBeInstanceOf(MissingInterpreter);
    expect(launch.spawn).not.toHaveBeenCalled();
    expect(launch.proton).not.toHaveBeenCalled();
  });
}
test("extension API routes a companion Windows tool through its actual Steam prefix", async () => {
  const { api } = harness();
  await api.runExecutable("/games/stardew/tool.exe", ["--flag"], {});
  expect(launch.proton).toHaveBeenCalledWith(
    api,
    "/games/stardew/tool.exe",
    ["--flag"],
    {},
    expect.objectContaining({ appid: "413150" }),
  );
  expect(launch.spawn).not.toHaveBeenCalled();
});
test("an outside tool can explicitly supply a working directory inside its game", async () => {
  const { api } = harness();
  await api.runExecutable("/tools/xedit.exe", [], { cwd: "/games/stardew" });
  expect(launch.proton).toHaveBeenCalledWith(
    api,
    "/tools/xedit.exe",
    [],
    { cwd: "/games/stardew" },
    expect.objectContaining({ appid: "413150" }),
  );
  expect(launch.spawn).not.toHaveBeenCalled();
});
test("Flatpak host dispatch preserves literal quotes in arguments and environment flags", async () => {
  const { api } = harness();
  const onSpawned = vi.fn(),
    onExit = vi.fn();
  const args = [
    "--host",
    "--directory=/games/space path",
    '--env=CUSTOM=literal "value"',
    '/host/quoted "tool"',
    'a "quote"',
    "$(literal)",
  ];
  await api.runExecutable("flatpak-spawn", args, {
    cwd: "/",
    shell: false,
    detach: false,
    onSpawned,
    onExit,
  });
  expect(launch.spawn.mock.calls[0].slice(0, 2)).toEqual(["flatpak-spawn", args]);
  expect(launch.spawn.mock.calls[0][2]).toEqual(
    expect.objectContaining({ cwd: "/", shell: false, detached: false }),
  );
  expect(onSpawned).toHaveBeenCalledWith(314);
  expect(onExit).toHaveBeenCalledWith(0, null);
  expect(launch.store).not.toHaveBeenCalled();
});

test("host dependency commands preserve their JSON environment and Python command", async () => {
  const { api } = harness();
  const args = [
    "--host",
    "flatpak",
    "run",
    '--env=VORTEX_DEPENDENCY_TARGET={"gamePath":"/games/space path","appid":"42"}',
    "com.github.Matoking.protontricks",
    "-c",
    "python3 -c 'print(\"literal value\")'",
    "42",
  ];
  await api.runExecutable("flatpak-spawn", args, { cwd: "/", shell: false });
  expect(launch.spawn.mock.calls[0].slice(0, 2)).toEqual(["flatpak-spawn", args]);
});

test("registered Linux interpreter remains authoritative", async () => {
  const { api, internals } = harness();
  internals.mInterpreters[".exe"] = (input) => ({
    ...input,
    executable: "/usr/bin/wine",
    args: [input.executable, ...input.args],
  });
  await api.runExecutable("/tools/xedit.exe", [], {});
  expect(launch.spawn).toHaveBeenCalledWith(
    "/usr/bin/wine",
    ["/tools/xedit.exe"],
    expect.anything(),
  );
  expect(launch.store).not.toHaveBeenCalled();
});
test("an interpreter which leaves a Windows executable unchanged cannot invoke binfmt", async () => {
  const { api, internals } = harness();
  internals.mInterpreters[".exe"] = (input) => input;
  await expect(api.runExecutable("/tools/xedit.exe", [], {})).rejects.toBeInstanceOf(
    MissingInterpreter,
  );
  expect(launch.spawn).not.toHaveBeenCalled();
});
test("a start hook cannot redirect a native launch into raw Windows execution", async () => {
  const { api, internals } = harness();
  internals.mStartHooks.push({
    id: "fixture",
    priority: 0,
    hook: (input) => PromiseBB.resolve({ ...input, executable: "/tools/xedit.exe" }),
  });
  await expect(api.runExecutable("/usr/bin/tool", [], {})).rejects.toBeInstanceOf(
    MissingInterpreter,
  );
  expect(launch.spawn).not.toHaveBeenCalled();
});
for (const platform of ["linux", "win32"] as const) {
  test(platform + " ordinary launches retain spawn and exit callbacks", async () => {
    const { api } = harness();
    vi.stubGlobal("process", { ...originalProcess, platform });
    const onSpawned = vi.fn(),
      onExit = vi.fn();
    const executable = platform === "linux" ? "/usr/bin/tool" : "C:/tools/tool.exe";
    await api.runExecutable(executable, [], { onSpawned, onExit });
    expect(launch.spawn).toHaveBeenCalledOnce();
    expect(onSpawned).toHaveBeenCalledWith(314);
    expect(onExit).toHaveBeenCalledWith(0, null);
    expect(launch.store).not.toHaveBeenCalled();
  });
}

for (const entry of [
  { gamePath: "/games/stardew", usesProton: true, appid: "" },
  { gamePath: "/games/stardew", appid: "413150" },
  { gamePath: "relative/game", usesProton: true, appid: "413150" },
]) {
  test(
    "an incomplete Steam entry cannot authorize a Windows launch: " + JSON.stringify(entry),
    async () => {
      const { api } = harness();
      launch.games.mockResolvedValue([entry]);
      await expect(api.runExecutable("/games/stardew/tool.exe", [], {})).rejects.toBeInstanceOf(
        MissingInterpreter,
      );
      expect(launch.spawn).not.toHaveBeenCalled();
      expect(launch.proton).not.toHaveBeenCalled();
    },
  );
}
test("a sibling directory is not the game's prefix", async () => {
  const { api } = harness();
  await expect(api.runExecutable("/games/stardew-other/tool.exe", [], {})).rejects.toBeInstanceOf(
    MissingInterpreter,
  );
  expect(launch.spawn).not.toHaveBeenCalled();
  expect(launch.proton).not.toHaveBeenCalled();
});
test("conflicting Steam app IDs for the same install directory are ambiguous", async () => {
  const { api } = harness();
  launch.games.mockResolvedValue([
    { gamePath: "/games/stardew", usesProton: true, appid: "413150" },
    { gamePath: "/games/stardew", usesProton: true, appid: "1245620" },
  ]);
  await expect(api.runExecutable("/games/stardew/tool.exe", [], {})).rejects.toBeInstanceOf(
    MissingInterpreter,
  );
  expect(launch.spawn).not.toHaveBeenCalled();
  expect(launch.proton).not.toHaveBeenCalled();
});
test("the executable's own game wins over another game's working directory", async () => {
  const { api } = harness();
  launch.games.mockResolvedValue([
    { gamePath: "/games/other", usesProton: true, appid: "1245620" },
    { gamePath: "/games/stardew", usesProton: true, appid: "413150" },
  ]);
  await api.runExecutable("/games/stardew/tool.EXE", [], { cwd: "/games/other" });
  expect(launch.proton).toHaveBeenCalledWith(
    api,
    "/games/stardew/tool.EXE",
    [],
    expect.anything(),
    expect.objectContaining({ appid: "413150" }),
  );
  expect(launch.spawn).not.toHaveBeenCalled();
});
test("a relative Windows command requires an explicit absolute game working directory", async () => {
  const { api } = harness();
  await api.runExecutable("tool.exe", [], { cwd: "/games/stardew" });
  expect(launch.proton).toHaveBeenCalledWith(
    api,
    "tool.exe",
    [],
    { cwd: "/games/stardew" },
    expect.objectContaining({ appid: "413150" }),
  );
  expect(launch.spawn).not.toHaveBeenCalled();
});

for (const steamReady of [false, true]) {
  test(
    "public StarterInfo honors the registered Linux interpreter with Steam ready=" + steamReady,
    async () => {
      const { api, internals } = harness();
      registerHarnessGame("skyrimse");
      api.getState().settings.gameMode.discovered.skyrimse = { path: "/games/stardew" };
      const info = makeStarterInfo({
        isGame: false,
        exePath: "/tools/xedit.exe",
        store: "steam",
        onStart: undefined,
      });
      const error = vi.fn();
      if (!steamReady) launch.store.mockReturnValue(undefined);
      internals.mInterpreters[".exe"] = (input) => ({
        ...input,
        executable: "/usr/bin/wine",
        args: [input.executable, ...input.args],
      });
      await StarterInfo.run(info, api, error);
      expect(launch.spawn).toHaveBeenCalledWith("/usr/bin/wine", [info.exePath], expect.anything());
      expect(launch.store).not.toHaveBeenCalled();
      expect(launch.proton).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    },
  );
}

for (const condition of [
  "missing-store",
  "disabled-store",
  "empty-snapshot",
  "missing-game",
  "native-build",
  "lookup-error",
] as const) {
  test("composed public starter refuses raw launch after " + condition, async () => {
    const { api } = harness();
    registerHarnessGame("skyrimse");
    api.getState().settings.gameMode.discovered.skyrimse = { path: "/games/stardew" };
    const info = makeStarterInfo({
      isGame: false,
      exePath: "/tools/xedit.exe",
      workingDirectory: "/tools",
      store: "steam",
      onStart: undefined,
    });
    if (condition === "missing-store") launch.store.mockReturnValue(undefined);
    if (condition === "disabled-store")
      launch.store.mockImplementation(() => {
        throw new GameStoreNotFound("steam");
      });
    if (condition === "empty-snapshot") launch.games.mockResolvedValue([]);
    if (condition === "missing-game") delete api.getState().settings.gameMode.discovered.skyrimse;
    if (condition === "native-build")
      launch.games.mockResolvedValue([
        { gamePath: "/games/stardew", usesProton: false, appid: "413150" },
      ]);
    if (condition === "lookup-error")
      launch.games.mockRejectedValue(new Error("Steam snapshot failed"));
    const error = vi.fn();
    await StarterInfo.run(info, api, error);
    expect(error).toHaveBeenCalledOnce();
    expect(launch.spawn).not.toHaveBeenCalled();
    expect(launch.proton).not.toHaveBeenCalled();
  });
}
test("the composed starter's explicit game beats another game's working directory", async () => {
  const { api } = harness();
  registerHarnessGame("skyrimse");
  api.getState().settings.gameMode.discovered.skyrimse = { path: "/games/stardew" };
  launch.games.mockResolvedValue([
    { gamePath: "/games/other", usesProton: true, appid: "1245620" },
    { gamePath: "/games/stardew", usesProton: true, appid: "413150" },
  ]);
  const info = makeStarterInfo({
    isGame: false,
    exePath: "/tools/xedit.exe",
    workingDirectory: "/games/other",
    store: "steam",
    onStart: undefined,
  });
  const error = vi.fn();
  await StarterInfo.run(info, api, error);
  expect(launch.proton).toHaveBeenCalledWith(
    api,
    info.exePath,
    info.commandLine,
    expect.objectContaining({ gameId: "skyrimse", cwd: "/games/other" }),
    expect.objectContaining({ appid: "413150" }),
  );
  expect(launch.spawn).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
});
test("an explicitly missing game cannot fall back to the executable or working directory", async () => {
  const { api } = harness();
  await expect(
    api.runExecutable("/games/stardew/tool.exe", [], { gameId: "missing", cwd: "/games/stardew" }),
  ).rejects.toBeInstanceOf(MissingInterpreter);
  expect(launch.spawn).not.toHaveBeenCalled();
  expect(launch.proton).not.toHaveBeenCalled();
});
test("a composed starter does not retry Proton after a registered interpreter fails", async () => {
  const { api, internals } = harness();
  registerHarnessGame("skyrimse");
  api.getState().settings.gameMode.discovered.skyrimse = { path: "/games/stardew" };
  const info = makeStarterInfo({
    isGame: false,
    exePath: "/tools/xedit.exe",
    store: "steam",
    onStart: undefined,
  });
  internals.mInterpreters[".exe"] = () => {
    throw new Error("Registered interpreter failed");
  };
  const error = vi.fn();
  await StarterInfo.run(info, api, error);
  expect(error).toHaveBeenCalledOnce();
  expect(launch.store).not.toHaveBeenCalled();
  expect(launch.proton).not.toHaveBeenCalled();
  expect(launch.spawn).not.toHaveBeenCalled();
});
test("a composed starter cannot bypass a registered interpreter which leaves a raw Windows command", async () => {
  const { api, internals } = harness();
  registerHarnessGame("skyrimse");
  api.getState().settings.gameMode.discovered.skyrimse = { path: "/games/stardew" };
  const info = makeStarterInfo({
    isGame: false,
    exePath: "/tools/xedit.exe",
    store: "steam",
    onStart: undefined,
  });
  internals.mInterpreters[".exe"] = (input) => input;
  const error = vi.fn();
  await StarterInfo.run(info, api, error);
  expect(error).toHaveBeenCalledOnce();
  expect(launch.store).not.toHaveBeenCalled();
  expect(launch.proton).not.toHaveBeenCalled();
  expect(launch.spawn).not.toHaveBeenCalled();
});
