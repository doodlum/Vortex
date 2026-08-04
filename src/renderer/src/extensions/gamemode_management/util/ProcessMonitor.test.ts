import * as path from "path";

import { it, expect, vi } from "vitest";

import { setToolPid, setToolStopped } from "../../../actions";
import { makeExeId } from "../../../reducers/session";
import type { IDiscoveredTool } from "../../../types/IDiscoveredTool";
import type { IExtensionApi } from "../../../types/IExtensionContext";
import type { IState } from "../../../types/IState";
import ProcessMonitor from "./ProcessMonitor";
import type { IProcessInfo, IProcessProvider } from "./processProvider";

const gameId = "test-game";
const profileId = "profile-1";
const gamePath = "/games/test";
const gameExe = "Game.exe";
const gameExePath = path.join(gamePath, gameExe);
const toolPath = "/games/test/Tool.exe";

const buildTool = (overrides: Partial<IDiscoveredTool> = {}): IDiscoveredTool => ({
  id: "tool-1",
  name: "Tool",
  executable: () => "Tool.exe",
  requiredFiles: [],
  path: toolPath,
  hidden: false,
  custom: true,
  exclusive: false,
  ...overrides,
});

const buildState = (
  overrides: {
    toolsRunning?: IState["session"]["base"]["toolsRunning"];
    tools?: { [id: string]: IDiscoveredTool };
    gamePath?: string;
    gameExe?: string;
  } = {},
): IState => {
  const resolvedGamePath = overrides.gamePath ?? gamePath;
  const resolvedGameExe = overrides.gameExe ?? gameExe;

  return {
    session: {
      base: {
        toolsRunning: overrides.toolsRunning ?? {},
      },
      gameMode: {
        known: [
          {
            id: gameId,
            name: "Test Game",
            executable: resolvedGameExe,
            requiredFiles: [],
          },
        ],
      },
    },
    settings: {
      profiles: {
        activeProfileId: profileId,
      },
      gameMode: {
        discovered: {
          [gameId]: {
            path: resolvedGamePath,
            executable: resolvedGameExe,
            tools: overrides.tools ?? {},
          },
        },
      },
    },
    persistent: {
      profiles: {
        [profileId]: { id: profileId, gameId },
      },
    },
  } as unknown as IState;
};

const createMonitor = (state: IState, processes: IProcessInfo[]) => {
  const store = {
    dispatch: vi.fn(),
    getState: vi.fn(() => state),
  };
  const processProvider: IProcessProvider = {
    list: vi.fn().mockResolvedValue(processes),
  };
  const monitor = new ProcessMonitor({ store } as unknown as IExtensionApi, processProvider);
  return {
    monitor: monitor as unknown as { doCheck(): Promise<void> },
    store,
    processProvider,
  };
};

it("dispatches setToolPid for matching child process", async () => {
  const tool = buildTool();
  const state = buildState({ tools: { [tool.id]: tool } });
  const processes: IProcessInfo[] = [
    {
      pid: 3001,
      ppid: process.pid,
      name: "Tool.exe",
      path: toolPath,
    },
  ];
  const { monitor, store } = createMonitor(state, processes);

  await monitor.doCheck();

  expect(store.dispatch).toHaveBeenCalledWith(setToolPid(toolPath, 3001, false));
});

it("dispatches setToolStopped when no matching process exists", async () => {
  const tool = buildTool();
  const state = buildState({
    tools: { [tool.id]: tool },
    toolsRunning: {
      [makeExeId(toolPath)]: { pid: 4001, started: 1, exclusive: false },
    },
  });
  const { monitor, store } = createMonitor(state, []);

  await monitor.doCheck();

  expect(store.dispatch).toHaveBeenCalledWith(setToolStopped(toolPath));
});

it("matches detached game but filters non-child tools", async () => {
  const tool = buildTool();
  const state = buildState({
    tools: { [tool.id]: tool },
    toolsRunning: {
      [makeExeId(toolPath)]: { pid: 5001, started: 1, exclusive: false },
    },
  });
  const processes: IProcessInfo[] = [
    {
      pid: 5001,
      ppid: 0,
      name: "Tool.exe",
      path: toolPath,
    },
    {
      pid: 6001,
      ppid: 0,
      name: "Game.exe",
      path: gameExePath,
    },
  ];
  const { monitor, store } = createMonitor(state, processes);

  await monitor.doCheck();

  expect(store.dispatch).toHaveBeenNthCalledWith(1, setToolPid(gameExePath, 6001, true));
  expect(store.dispatch).toHaveBeenNthCalledWith(2, setToolStopped(toolPath));
});

it("preserves an absolute executable returned by game discovery", async () => {
  const absoluteExe = "/games/test/Game.exe";
  const state = buildState({ gamePath: "/games/test", gameExe: absoluteExe });
  const processes: IProcessInfo[] = [{ pid: 6002, ppid: 0, name: "Game.exe", path: absoluteExe }];
  const { monitor, store } = createMonitor(state, processes);

  await monitor.doCheck();

  expect(store.dispatch).toHaveBeenCalledWith(setToolPid(absoluteExe, 6002, true));
  expect(store.dispatch).not.toHaveBeenCalledWith(
    setToolPid(path.join("/games/test", absoluteExe), 6002, true),
  );
});

it("parses unquoted cmd paths with spaces", async () => {
  const spacedGamePath = "/games/test path";
  const spacedGameExe = "StardewValley";
  const spacedGameExePath = path.join(spacedGamePath, spacedGameExe);
  const state = buildState({
    gamePath: spacedGamePath,
    gameExe: spacedGameExe,
  });
  const processes: IProcessInfo[] = [
    {
      pid: 8001,
      ppid: 0,
      name: spacedGameExe,
      cmd: `${spacedGameExePath} --arg`,
    },
  ];
  const { monitor, store } = createMonitor(state, processes);

  await monitor.doCheck();

  expect(store.dispatch).toHaveBeenCalledWith(setToolPid(spacedGameExePath, 8001, true));
});

it("matches a game running under Wine, which reports a Z: drive path", async () => {
  // Proton maps Z: to the filesystem root, so this is the same file as gameExePath -- but compared
  // literally it is not, and the game used to be reported as stopped while it was running.
  const wineGamePath = "/home/deck/.local/share/Steam/steamapps/common/Skyrim Special Edition";
  const wineGameExe = "SkyrimSE.exe";
  const state = buildState({ gamePath: wineGamePath, gameExe: wineGameExe });
  const processes: IProcessInfo[] = [
    {
      pid: 9101,
      ppid: 0,
      name: wineGameExe,
      cmd: "Z:\\home\\deck\\.local\\share\\Steam\\steamapps\\common\\Skyrim Special Edition\\SkyrimSE.exe",
    },
  ];
  const { monitor, store } = createMonitor(state, processes);

  await monitor.doCheck();

  expect(store.dispatch).toHaveBeenCalledWith(
    setToolPid(path.join(wineGamePath, wineGameExe), 9101, true),
  );
});

it("matches a Wine drive letter it cannot resolve by falling back to the directory", async () => {
  // A prefix can map any letter to any directory; the mapping is not visible from here, so the
  // basename plus its own directory has to be enough.
  const state = buildState({ gamePath: "/games/test", gameExe: "Game.exe" });
  const processes: IProcessInfo[] = [
    { pid: 9102, ppid: 0, name: "Game.exe", cmd: "D:\\test\\Game.exe" },
  ];
  const { monitor, store } = createMonitor(state, processes);

  await monitor.doCheck();

  expect(store.dispatch).toHaveBeenCalledWith(setToolPid(gameExePath, 9102, true));
});

it("does not match a same-named executable in an unrelated directory", async () => {
  const state = buildState({ gamePath: "/games/test", gameExe: "Game.exe" });
  const processes: IProcessInfo[] = [
    { pid: 9103, ppid: 0, name: "Game.exe", cmd: "Z:\\elsewhere\\other\\Game.exe" },
  ];
  const { monitor, store } = createMonitor(state, processes);

  await monitor.doCheck();

  expect(store.dispatch).not.toHaveBeenCalledWith(setToolPid(gameExePath, 9103, true));
});

it("matches a Wine process whose reported name is not the executable", async () => {
  // Wine renames the process to its main thread, so `name` here is neither the game nor a
  // truncation of it -- only the command line identifies what is running.
  const wineGamePath = "/home/deck/.local/share/Steam/steamapps/common/Skyrim Special Edition";
  const state = buildState({ gamePath: wineGamePath, gameExe: "SkyrimSE.exe" });
  const processes: IProcessInfo[] = [
    {
      pid: 9104,
      ppid: 0,
      name: "ThreadPoolForeg",
      cmd: "Z:\\home\\deck\\.local\\share\\Steam\\steamapps\\common\\Skyrim Special Edition\\SkyrimSE.exe",
    },
  ];
  const { monitor, store } = createMonitor(state, processes);

  await monitor.doCheck();

  expect(store.dispatch).toHaveBeenCalledWith(
    setToolPid(path.join(wineGamePath, "SkyrimSE.exe"), 9104, true),
  );
});

it("matches the doubled separator Proton actually reports", async () => {
  // Observed verbatim from a running Skyrim on a Steam Deck: the separator before the executable
  // is doubled, which defeats a straight string comparison.
  const wineGamePath = "/home/deck/.local/share/Steam/steamapps/common/Skyrim Special Edition";
  const state = buildState({ gamePath: wineGamePath, gameExe: "SkyrimSE.exe" });
  const processes: IProcessInfo[] = [
    {
      pid: 9105,
      ppid: 0,
      name: "SkyrimSE.exe",
      cmd: "Z:\\home\\deck\\.local\\share\\Steam\\steamapps\\common\\Skyrim Special Edition\\\\SkyrimSE.exe",
    },
  ];
  const { monitor, store } = createMonitor(state, processes);

  await monitor.doCheck();

  expect(store.dispatch).toHaveBeenCalledWith(
    setToolPid(path.join(wineGamePath, "SkyrimSE.exe"), 9105, true),
  );
});

it("does not match a wrapper that merely takes the executable as an argument", async () => {
  // Steam's launch chain passes the game (or the script extender) to pressure-vessel and Proton as
  // arguments. Treating that as the wrapper's own executable reported the tool as running when only
  // the wrapper was -- and it kept "running" after the game had exited.
  const state = buildState({ tools: {}, gamePath: "/games/test", gameExe: "Game.exe" });
  const processes: IProcessInfo[] = [
    {
      pid: 9201,
      ppid: 0,
      name: "pressure-vessel",
      cmd: "/usr/lib/pressure-vessel/bin/pv-adverb --generate-locales -- /games/test/Game.exe",
    },
  ];
  const { monitor, store } = createMonitor(state, processes);

  await monitor.doCheck();

  expect(store.dispatch).not.toHaveBeenCalledWith(setToolPid(gameExePath, 9201, true));
});

it("skips dispatch when known pid still exists", async () => {
  const state = buildState({
    tools: {},
    toolsRunning: {
      [makeExeId(gameExePath)]: {
        pid: 7001,
        started: 1,
        exclusive: true,
      },
    },
  });
  const processes: IProcessInfo[] = [
    {
      pid: 7001,
      ppid: 0,
      name: "Game.exe",
      path: gameExePath,
    },
  ];
  const { monitor, store } = createMonitor(state, processes);

  await monitor.doCheck();

  expect(store.dispatch).not.toHaveBeenCalled();
});
