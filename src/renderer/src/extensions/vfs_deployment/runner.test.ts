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
        profiles: { activeProfileId: "plainProfile" },
      },
      persistent: { profiles: { plainProfile: { gameId: "plain" } } },
    }),
  } as unknown as IExtensionApi;
  const state = api.getState();

  it("associates a cwd-local PATHEXT script with the active game and its virtual input", async () => {
    fs.mkdirSync(dataPath, { recursive: true });
    const script = path.join(dataPath, "LocalProbe.cmd");
    fs.writeFileSync(script, "fixture script");
    fakes.deployment = {
      gamePath,
      stagingPath,
      deployments: [{ targetPath: dataPath, files: [file("virtual-input.txt")] }],
    };
    const started = await makeLaunchRunner(api)({
      executable: "LocalProbe",
      args: ['"virtual-input.txt"'],
      cwd: dataPath,
      options: { shell: true, env: { PATHEXT: ".cmd;.exe" } },
    });
    expect(started).toBeDefined();
    const session = fakes.sessions.at(-1)!;
    expect(session.launches).toContainEqual(
      expect.objectContaining({
        args: ["/d", "/s", "/c", `""${script}" "virtual-input.txt""`],
      }),
    );
    expect((session.given[0] as IAetherRoot).files).toContainEqual({
      path: path.join("Data", "virtual-input.txt"),
      source: path.join(stagingPath, "Mod", "virtual-input.txt"),
    });
    session.end();
    await started!.exited;
  });

  it("keeps Steam identity beside a resolved cwd-local script", async () => {
    fs.mkdirSync(dataPath, { recursive: true });
    fs.writeFileSync(path.join(dataPath, "SteamProbe.cmd"), "fixture script");
    fakes.deployment = { gamePath, stagingPath, deployments: [] };
    const steamApi = {
      getState: () => ({
        settings: {
          gameMode: { discovered: { steamgame: { path: gamePath } } },
          profiles: { activeProfileId: "steamProfile" },
        },
        persistent: { profiles: { steamProfile: { gameId: "steamgame" } } },
      }),
    } as unknown as IExtensionApi;
    const started = await makeLaunchRunner(steamApi)({
      executable: "SteamProbe",
      args: [],
      cwd: dataPath,
      options: { shell: true, env: { PATHEXT: ".cmd" } },
    });
    const session = fakes.sessions.at(-1)!;
    expect(session.launches).toContainEqual(
      expect.objectContaining({
        env: { PATHEXT: ".cmd", SteamAppId: "489830", SteamGameId: "489830" },
      }),
    );
    expect((session.given[0] as IAetherRoot).files).toContainEqual(
      expect.objectContaining({
        path: path.join("Data", "steam_appid.txt"),
      }),
    );
    session.end();
    await started!.exited;
  });

  it("leaves a bare shell command available for the interpreter's PATHEXT lookup", async () => {
    fakes.deployment = { gamePath, stagingPath, deployments: [] };
    const started = await makeLaunchRunner(api)({
      executable: "PathOnlyProbe",
      args: ['"output & file.txt"'],
      cwd: dataPath,
      options: { gameId: "plain", shell: true, env: { PATH: path.join(dir, "script tools") } },
    });
    const session = fakes.sessions.at(-1)!;
    expect(session.launches).toContainEqual(
      expect.objectContaining({
        args: ["/d", "/s", "/c", '""PathOnlyProbe" "output & file.txt""'],
        windowsVerbatimArguments: true,
      }),
    );
    session.end();
    await started!.exited;
  });

  for (const shell of [false, true]) {
    it(`runs an explicit command interpreter once with verbatim arguments (shell=${shell})`, async () => {
      fakes.deployment = { gamePath, stagingPath, deployments: [] };
      const executable = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
      const args = ["/D", "/S", "/K", '""script & tool.cmd" "input & file.txt""'];
      const started = await makeLaunchRunner(api)({
        executable,
        args,
        cwd: dataPath,
        options: { gameId: "plain", shell },
      });
      const session = fakes.sessions.at(-1)!;
      expect(session.launches).toContainEqual(
        expect.objectContaining({
          image: executable,
          args,
          windowsVerbatimArguments: true,
        }),
      );
      session.end();
      await started!.exited;
    });
  }

  it("finds an interpreter on the launch environment's PATH rather than inside the game", async () => {
    fakes.deployment = { gamePath, stagingPath, deployments: [] };
    const tools = path.join(dir, "path tools");
    fs.mkdirSync(tools, { recursive: true });
    const interpreter = path.join(tools, "interpreter.exe");
    fs.writeFileSync(interpreter, "fixture");
    const started = await makeLaunchRunner(api)({
      executable: "interpreter.exe",
      args: ["script.cmd"],
      cwd: dataPath,
      options: { gameId: "plain", env: { Path: `\"${tools}\"` }, shell: false },
    });
    const session = fakes.sessions.at(-1)!;
    expect(session.launches).toContainEqual(
      expect.objectContaining({
        image: interpreter,
        args: ["script.cmd"],
        windowsVerbatimArguments: false,
      }),
    );
    session.end();
    await started!.exited;
  });

  it("uses a differently cased caller PATH override for lookup and the injected environment", async () => {
    fakes.deployment = { gamePath, stagingPath, deployments: [] };
    const inherited = path.join(dir, "inherited tools");
    const requested = path.join(dir, "requested tools");
    for (const folder of [inherited, requested]) {
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, "override.exe"), "fixture");
    }
    const started = await makeLaunchRunner(api)({
      executable: "override.exe",
      args: [],
      cwd: dataPath,
      options: { gameId: "plain", env: { Path: inherited, PATH: requested } },
    });
    const session = fakes.sessions.at(-1)!;
    expect(session.launches).toContainEqual(
      expect.objectContaining({
        image: path.join(requested, "override.exe"),
        env: { PATH: requested },
      }),
    );
    session.end();
    await started!.exited;
  });

  for (const name of ["local-tool", ".\\local-tool"]) {
    it(`resolves ${name} in the requested working directory and supplies its executable suffix`, async () => {
      fakes.deployment = { gamePath, stagingPath, deployments: [] };
      fs.mkdirSync(dataPath, { recursive: true });
      const executable = path.join(dataPath, "local-tool.exe");
      fs.writeFileSync(executable, "fixture");
      const started = await makeLaunchRunner(api)({
        executable: name,
        args: [],
        cwd: dataPath,
        options: { gameId: "plain", shell: false },
      });
      expect(started).toBeDefined();
      const session = fakes.sessions.at(-1)!;
      expect(session.launches).toContainEqual(expect.objectContaining({ image: executable }));
      session.end();
      await started!.exited;
    });
  }

  it("routes a game's shell script through an injected command interpreter without losing shell quoting", async () => {
    fakes.deployment = {
      gamePath,
      stagingPath,
      deployments: [{ targetPath: dataPath, files: [file("a.esp")] }],
    };
    const script = path.join(gamePath, "script with spaces.cmd");
    const args = ['"argument with spaces"', '"quoted & literal"'];
    const started = await makeLaunchRunner(api)({
      executable: script,
      args,
      cwd: dataPath,
      options: { gameId: "plain", shell: true },
    });
    expect(started).toBeDefined();
    const session = fakes.sessions.at(-1)!;
    expect(session.launches).toContainEqual(
      expect.objectContaining({
        image:
          process.env.comspec ??
          path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe"),
        cwd: dataPath,
        args: ["/d", "/s", "/c", `""${script}" ${args.join(" ")}"`],
        windowsVerbatimArguments: true,
      }),
    );
    session.end();
    await started!.exited;
  });

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
      expect.objectContaining({ image: helper, args: ["worker.js"], cwd: dir }),
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
