import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import vm from "node:vm";

import { afterEach, expect, it } from "vitest";

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(platform: "linux" | "win32", executable: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dfu-target-"));
  directories.push(root);
  const gamePath = path.join(root, "Game With Spaces");
  fs.mkdirSync(path.join(gamePath, "DaggerfallUnity_Data"), { recursive: true });
  fs.writeFileSync(path.join(gamePath, executable), "inert executable fixture");
  const context: any = {
    api: {
      getState: () => ({
        settings: { gameMode: { discovered: { daggerfallunity: { path: gamePath } } } },
      }),
    },
    registerGame(game: any) {
      this.game = game;
    },
    registerInstaller(_id: string, _priority: number, supported: any, install: any) {
      this.supported = supported;
      this.install = install;
    },
  };
  const module = { exports: {} as any };
  const api = {
    fs: {
      ...fs,
      readFileAsync: fs.promises.readFile,
      statAsync: fs.promises.stat,
      ensureDirWritableAsync: (p: string) => fs.promises.mkdir(p, { recursive: true }),
    },
    util: { getVortexPath: (key: string) => path.join(root, key), DataInvalid: Error },
  };
  vm.runInNewContext(fs.readFileSync(path.join(import.meta.dirname, "index.js"), "utf8"), {
    module,
    process: { platform, env: { XDG_CONFIG_HOME: path.join(root, "config") } },
    require: (id: string) =>
      id === "@nexusmods/vortex-api"
        ? api
        : id === "path" || id === "node:path"
          ? path
          : id === "fs" || id === "node:fs"
            ? fs
            : undefined,
  });
  module.exports.default(context);
  return { context, gamePath, root };
}

it("registers a genuine native Linux installation without requiring a fake exe", () => {
  const { context, gamePath } = fixture("linux", "DaggerfallUnity.x86_64");
  expect(
    context.game.requiredFiles.every((name: string) => fs.existsSync(path.join(gamePath, name))),
  ).toBe(true);
  expect(context.game.executable(gamePath)).toBe("DaggerfallUnity.x86_64");
});

it("selects Linux dfmods and common resources for the selected native game", async () => {
  const { context, gamePath } = fixture("linux", "DaggerfallUnity.x86_64");
  const files = [
    "Windows/Example.dfmod",
    "Linux/Example.dfmod",
    "OSX/Example.dfmod",
    "Textures/Common.png",
  ];
  const result = await context.install(files, gamePath);
  expect(result.instructions.map((x: any) => x.source)).toEqual([
    "Linux/Example.dfmod",
    "Textures/Common.png",
  ]);
  expect(result.instructions[0].destination).toBe(path.join("Mods", "Example.dfmod"));
});

it.each(["linux", "win32"] as const)(
  "%s keeps Windows payloads for a Windows installation",
  async (host) => {
    const { context, gamePath } = fixture(host, "DaggerfallUnity.exe");
    expect(context.game.executable(gamePath)).toBe("DaggerfallUnity.exe");
    const result = await context.install(
      ["Windows/Example.dfmod", "Linux/Example.dfmod", "OSX/Example.dfmod", "Textures/Common.png"],
      gamePath,
    );
    expect(result.instructions.map((x: any) => x.source)).toEqual([
      "Windows/Example.dfmod",
      "Textures/Common.png",
    ]);
  },
);

it("refuses an incomplete native installation instead of guessing a Windows or native executable", async () => {
  const { context, gamePath } = fixture("linux", "unrelated-file");
  expect(() => context.game.executable(gamePath)).toThrow("does not contain");
  await expect(context.game.setup({ path: gamePath })).rejects.toThrow("does not contain");
  expect(() => context.install(["Linux/Example.dfmod"], gamePath)).toThrow("does not contain");
});

it("finds native game/version from its Unity configuration log without taking command arguments as the path", async () => {
  const { context, gamePath, root } = fixture("linux", "DaggerfallUnity.x86_64");
  const log = path.join(
    root,
    "config",
    "unity3d",
    "Daggerfall Workshop",
    "Daggerfall Unity",
    "DFTFU_Environment.log",
  );
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(
    log,
    `CommandLine | "${path.join(gamePath, "DaggerfallUnity.x86_64")}" -foo bar\nVersion | 1.1.1\n`,
  );
  expect(await context.game.queryPath()).toBe(gamePath);
  expect(await context.game.getGameVersion(gamePath)).toBe("1.1.1");
});

it("keeps common resources containing an OS word and handles archive separators as components", async () => {
  const { context, gamePath } = fixture("linux", "DaggerfallUnity.x86_64");
  const files = [
    "linux\\Example.dfmod",
    "windows\\Example.dfmod",
    "Textures/LinuxInspired/Common.png",
    "Linux/Textures/Native.png",
    "Windows/Textures/Windows.png",
    "Linux/Windows/Ambiguous.dfmod",
  ];
  const result = await context.install(files, gamePath);
  expect(result.instructions.map((x: any) => x.source)).toEqual([files[0], files[2], files[3]]);
});

it("keeps Windows log/version handling for a Windows target on Linux", async () => {
  const { context, gamePath, root } = fixture("linux", "DaggerfallUnity.exe");
  const log = path.join(
    root,
    "LocalLow",
    "Daggerfall Workshop",
    "Daggerfall Unity",
    "DFTFU_Environment.log",
  );
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(
    log,
    `CommandLine | "${path.join(gamePath, "DaggerfallUnity.exe")}" -foo\nVersion | 1.1.1\n`,
  );
  expect(await context.game.queryPath()).toBe(gamePath);
  expect(await context.game.getGameVersion(gamePath)).toBe("1.1.1");
});

it.each(["linux", "win32"] as const)(
  "%s registers and browses before discovery, even with a removed old path",
  (host) => {
    const { context, gamePath } = fixture(
      host,
      host === "linux" ? "DaggerfallUnity.x86_64" : "DaggerfallUnity.exe",
    );
    context.api.getState = () => ({ settings: { gameMode: { discovered: {} } } });
    const defaultExecutable = host === "linux" ? "DaggerfallUnity.x86_64" : "DaggerfallUnity.exe";
    // GameModeManager.storeGame and manual/automatic discovery call this before recording a path.
    expect(context.game.executable()).toBe(defaultExecutable);
    expect(context.game.executable(gamePath)).toBe(defaultExecutable);
    context.api.getState = () => ({
      settings: {
        gameMode: { discovered: { daggerfallunity: { path: path.join(gamePath, "Removed") } } },
      },
    });
    expect(context.game.executable()).toBe(defaultExecutable);
    if (host === "linux")
      expect(() => context.game.executable(path.join(gamePath, "Removed"))).toThrow(
        "does not contain",
      );
  },
);
