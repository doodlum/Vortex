import * as realFsModule from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { install, setVirtualFiles, virtualSource } from "./vfsFsView";

// A copy of `fs` to wrap, so the real module (shared by every test in this worker) is untouched.
const fs = {
  ...realFsModule,
  promises: { ...realFsModule.promises },
  Dirent: realFsModule.Dirent,
} as typeof realFsModule;
install(fs);

const root = realFsModule.mkdtempSync(path.join(os.tmpdir(), "vortex-vfs-view-"));
afterAll(() => realFsModule.rmSync(root, { recursive: true, force: true }));
const game = path.join(root, "Game");
const staging = path.join(root, "staging", "SomeMod");
realFsModule.mkdirSync(game, { recursive: true });
realFsModule.mkdirSync(path.join(staging, "textures"), { recursive: true });
realFsModule.writeFileSync(path.join(game, "Game.exe"), "real exe");
realFsModule.writeFileSync(path.join(staging, "mod.esp"), "mod plugin");
realFsModule.writeFileSync(path.join(staging, "textures", "x.dds"), "texture");

const deploy = () =>
  setVirtualFiles(
    "game",
    [game],
    [
      { deployed: path.join(game, "Data", "mod.esp"), source: path.join(staging, "mod.esp") },
      {
        deployed: path.join(game, "Data", "textures", "x.dds"),
        source: path.join(staging, "textures", "x.dds"),
      },
    ],
  );

beforeEach(deploy);

describe("the deployed view of fs", () => {
  it("reads a virtually deployed file from its staged source, every way it can be read", async () => {
    const deployed = path.join(game, "Data", "mod.esp");
    expect(fs.readFileSync(deployed, "utf8")).toBe("mod plugin");
    expect(await fs.promises.readFile(deployed, "utf8")).toBe("mod plugin");
    await new Promise<void>((resolve, reject) =>
      fs.readFile(deployed, "utf8", (err, data) => {
        if (err) return reject(err);
        expect(data).toBe("mod plugin");
        resolve();
      }),
    );
    const fd = fs.openSync(deployed, "r");
    const buffer = Buffer.alloc(10);
    fs.readSync(fd, buffer, 0, 10, 0);
    fs.closeSync(fd);
    expect(buffer.toString()).toBe("mod plugin");
    const handle = await fs.promises.open(deployed);
    expect((await handle.readFile()).toString()).toBe("mod plugin");
    await handle.close();
    const streamed = await new Promise<string>((resolve) => {
      let text = "";
      fs.createReadStream(deployed, "utf8")
        .on("data", (chunk) => (text += chunk))
        .on("end", () => resolve(text));
    });
    expect(streamed).toBe("mod plugin");
  });

  it("answers existence and stats for files and for folders only mods provide", async () => {
    expect(fs.existsSync(path.join(game, "Data", "textures", "x.dds"))).toBe(true);
    expect(fs.statSync(path.join(game, "Data", "mod.esp")).size).toBe("mod plugin".length);
    expect(fs.statSync(path.join(game, "Data")).isDirectory()).toBe(true);
    expect((await fs.promises.stat(path.join(game, "Data", "textures"))).isDirectory()).toBe(true);
    await expect(fs.promises.access(path.join(game, "Data", "mod.esp"))).resolves.toBeUndefined();
    expect(fs.existsSync(path.join(game, "Data", "missing.esp"))).toBe(false);
  });

  it("lists the game folder with the deployed files and folders merged in", async () => {
    expect(fs.readdirSync(game).sort()).toEqual(["Data", "Game.exe"]);
    expect((await fs.promises.readdir(path.join(game, "Data"))).sort()).toEqual([
      "mod.esp",
      "textures",
    ]);
    const typed = fs.readdirSync(path.join(game, "Data"), { withFileTypes: true });
    const kinds = Object.fromEntries(typed.map((e) => [e.name, e.isDirectory() ? "dir" : "file"]));
    expect(kinds).toEqual({ "mod.esp": "file", textures: "dir" });
    expect(typed.every((e) => e instanceof realFsModule.Dirent)).toBe(true);
    const viaCallback = await new Promise<string[]>((resolve, reject) =>
      fs.readdir(path.join(game, "Data", "textures"), (err, names) =>
        err ? reject(err) : resolve(names as string[]),
      ),
    );
    expect(viaCallback).toEqual(["x.dds"]);
  });

  it("matches names as the game does on Windows", () => {
    if (process.platform !== "win32") return;
    expect(fs.readFileSync(path.join(game, "DATA", "MOD.ESP"), "utf8")).toBe("mod plugin");
    expect(virtualSource(path.join(game, "data", "Textures", "X.DDS"))).toBe(
      path.join(staging, "textures", "x.dds"),
    );
  });

  it("writes a mod's deployed file through to its staged file, as a hard link did", async () => {
    const deployed = path.join(game, "Data", "mod.esp");
    const staged = path.join(staging, "mod.esp");
    fs.writeFileSync(deployed, "edited plugin");
    expect(realFsModule.readFileSync(staged, "utf8")).toBe("edited plugin");
    const handle = await fs.promises.open(deployed, "r+");
    await handle.write("E", 0);
    await handle.close();
    expect(realFsModule.readFileSync(staged, "utf8")).toBe("Edited plugin");
    // File-time load orders set plugin times; the game then sees the staged file's.
    const time = new Date(2001, 1, 1);
    fs.utimesSync(deployed, time, time);
    expect(realFsModule.statSync(staged).mtime.getTime()).toBe(time.getTime());
    expect(realFsModule.existsSync(path.join(game, "Data", "mod.esp"))).toBe(false);
    realFsModule.writeFileSync(staged, "mod plugin");
  });

  it("leaves writes, other folders and a purged deployment alone", () => {
    const written = path.join(game, "Data", "written.txt");
    // A folder only mods provide does not exist on disk: a real write needs it made first.
    realFsModule.mkdirSync(path.dirname(written), { recursive: true });
    const fd = fs.openSync(written, "w");
    fs.closeSync(fd);
    // The write created a real file in the real folder, not in staging.
    expect(realFsModule.existsSync(written)).toBe(true);
    realFsModule.rmSync(path.join(game, "Data"), { recursive: true, force: true });
    expect(fs.readdirSync(staging).sort()).toEqual(["mod.esp", "textures"]);

    setVirtualFiles("game", [game], []);
    expect(fs.existsSync(path.join(game, "Data", "mod.esp"))).toBe(false);
    expect(fs.readdirSync(game)).toEqual(["Game.exe"]);
    expect(() => fs.readdirSync(path.join(game, "Data"))).toThrow(/ENOENT/);
  });
});
