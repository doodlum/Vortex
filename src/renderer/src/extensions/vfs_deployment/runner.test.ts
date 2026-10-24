import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("../gamemode_management/util/getGame", () => ({
  getGame: (gameId: string) =>
    gameId === "steamgame" ? { details: { steamAppId: 489830 } } : { details: {} },
}));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vortex-vfs-steam-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const fakes = vi.hoisted(() => ({
  sessions: [] as Array<{
    given: unknown[];
    setRoot: Mock;
    close: Mock;
    launches: unknown[];
    end: () => void;
  }>,
  deployment: undefined as unknown,
}));

vi.mock("../../util/getVortexPath", () => ({ default: () => dir }));
vi.mock("../mod_management/util/deploymentMethods", () => ({
  getCurrentActivator: () => ({ id: "aether_vfs" }),
}));
vi.mock("./support", () => ({ gameExecutable: () => undefined }));
vi.mock("./aether", () => ({
  loadAether: () => ({
    dir,
    createSession: (_stateDir: string, roots: unknown[]) => {
      let end = () => undefined as void;
      const ended = new Promise<{ kind: string; code: number }>((resolve) => {
        end = () => resolve({ kind: "exited", code: 0 });
      });
      const session = {
        given: roots,
        roots: () => [],
        setRoot: vi.fn(),
        close: vi.fn(),
        launches: [] as unknown[],
        end: () => end(),
        start: () => undefined,
        launch: (opts: unknown) => {
          session.launches.push(opts);
          return Promise.resolve({ pid: 42, notes: [], wait: () => ended });
        },
      };
      fakes.sessions.push(session);
      return session;
    },
  }),
}));
vi.mock("./roots", async (original) => ({
  ...(await original<typeof RootsModule>()),
  deploymentForGame: () => Promise.resolve(fakes.deployment),
}));

import type { IExtensionApi } from "../../types/IExtensionContext";
import type { IAetherRoot } from "./aether";
import type * as RootsModule from "./roots";
import { cleanStaleSessions, makeLaunchRunner, steamIdentity } from "./runner";
import { hideDeployment, showDeployment } from "./view";

function gameRoot(name: string): IAetherRoot {
  const location = path.join(dir, name);
  fs.mkdirSync(location, { recursive: true });
  return { location, base: location, files: [] };
}

describe("steamIdentity", () => {
  it("serves steam_appid.txt beside the game and names the app in its environment", () => {
    const root = gameRoot("game");
    const stateDir = path.join(dir, "state");
    const env = steamIdentity(
      "steamgame",
      path.join(root.location, "Game.exe"),
      [root],
      stateDir,
      {},
    );

    expect(env).toEqual({ SteamAppId: "489830", SteamGameId: "489830" });
    expect(root.files).toEqual([
      { path: "steam_appid.txt", source: path.join(stateDir, "steam_appid.txt") },
    ]);
    expect(fs.readFileSync(root.files[0].source, "utf8")).toBe("489830");
    // Nothing is written into the game folder itself.
    expect(fs.readdirSync(root.location)).toEqual([]);
  });

  it("puts the file beside an executable in a subfolder", () => {
    const root = gameRoot("game-bin");
    const exe = path.join(root.location, "bin", "x64", "Game.exe");
    steamIdentity("steamgame", exe, [root], path.join(dir, "state-bin"), {});
    expect(root.files[0].path).toBe(path.join("bin", "x64", "steam_appid.txt"));
  });

  it("leaves a real steam_appid.txt and the caller's own variables alone", () => {
    const root = gameRoot("game-own");
    fs.writeFileSync(path.join(root.location, "steam_appid.txt"), "1");
    const env = steamIdentity(
      "steamgame",
      path.join(root.location, "Game.exe"),
      [root],
      path.join(dir, "s"),
      {
        SteamAppId: "1",
      },
    );
    expect(root.files).toEqual([]);
    expect(env).toEqual({ SteamGameId: "489830" });
  });

  it("does nothing for a game without a Steam app id, or a program outside the game", () => {
    const root = gameRoot("game-other");
    expect(steamIdentity("nosteam", path.join(root.location, "Game.exe"), [root], dir, {})).toEqual(
      {},
    );
    expect(
      steamIdentity("steamgame", path.join(dir, "elsewhere", "Tool.exe"), [root], dir, {}),
    ).toEqual({});
    expect(root.files).toEqual([]);
  });
});

describe("cleanStaleSessions", () => {
  it("removes the session folders of ended Vortex processes only", async () => {
    const sessions = path.join(dir, "vfs-sessions");
    // Process ids are multiples of four on Windows; this one is not, so no process has it.
    const names = [`g-${process.pid}-1-0`, "g-4194303-1-0", "not-a-session"];
    for (const name of names) fs.mkdirSync(path.join(sessions, name), { recursive: true });
    cleanStaleSessions();
    await vi.waitFor(() => expect(fs.existsSync(path.join(sessions, names[1]))).toBe(false));
    expect(fs.readdirSync(sessions).sort()).toEqual([names[0], names[2]].sort());
  });
});

describe.runIf(process.platform === "win32")("a running program's view", () => {
  const gamePath = path.join(dir, "live-game");
  const stagingPath = path.join(dir, "live-staging");
  const dataPath = path.join(gamePath, "Data");
  const file = (name: string) => ({ relPath: name, source: "Mod", time: 0 });
  const api = {
    getState: () => ({
      settings: {
        gameMode: { discovered: { plain: { path: gamePath } } },
        profiles: { activeProfileId: undefined },
      },
      persistent: { profiles: {} },
    }),
  } as unknown as IExtensionApi;
  const state = api.getState();

  it("runs a helper named for the game in its session and follows later deploys", async () => {
    fakes.deployment = {
      gamePath,
      stagingPath,
      deployments: [{ targetPath: dataPath, files: [file("a.esp")] }],
    };
    const helper = path.join(dir, "Vortex", "Vortex.exe");
    const runner = makeLaunchRunner(api);
    // Outside the game folder and not named for it: a plain spawn.
    expect(runner({ executable: helper, args: [], options: {}, cwd: dir })).toBeUndefined();

    // Before the view holds the game, the session is composed from the manifests.
    const started = await runner({
      executable: helper,
      args: ["worker.js"],
      options: { vfsGameId: "plain", env: { ELECTRON_RUN_AS_NODE: "1" } },
      cwd: dir,
    })!;
    const session = fakes.sessions.at(-1)!;
    expect(started.pid).toBe(42);
    expect(session.launches).toEqual([
      expect.objectContaining({ image: helper, args: ["worker.js"] }),
    ]);
    expect((session.given[0] as IAetherRoot).files).toEqual([
      { path: path.join("Data", "a.esp"), source: path.join(stagingPath, "Mod", "a.esp") },
    ]);

    // Vortex deploys: the view changes, and the running program with it.
    showDeployment(state, "plain", "", dataPath, stagingPath, [file("b.esp")]);
    expect(session.setRoot).toHaveBeenCalledTimes(1);
    const [id, root] = session.setRoot.mock.calls[0] as [number, IAetherRoot];
    expect(id).toBe(0);
    expect(root.location).toBe(gamePath);
    expect(root.files).toEqual([
      { path: path.join("Data", "b.esp"), source: path.join(stagingPath, "Mod", "b.esp") },
    ]);

    // A purge: nothing left.
    hideDeployment(state, "plain", dataPath);
    expect((session.setRoot.mock.calls[1][1] as IAetherRoot).files).toEqual([]);

    session.end();
    await started.exited;
    expect(session.close).toHaveBeenCalled();
    showDeployment(state, "plain", "", dataPath, stagingPath, [file("c.esp")]);
    expect(session.setRoot).toHaveBeenCalledTimes(2);
  });

  it("leaves a session alone when a deploy needs a root it does not have", async () => {
    const started = await makeLaunchRunner(api)({
      executable: path.join(gamePath, "Game.exe"),
      args: [],
      options: { gameId: "plain" },
      cwd: gamePath,
    })!;
    const session = fakes.sessions.at(-1)!;
    showDeployment(state, "plain", "docs", path.join(dir, "Documents", "Mods"), stagingPath, [
      file("x.cfg"),
    ]);
    expect(session.setRoot).not.toHaveBeenCalled();
    session.end();
    await started.exited;
  });
});
