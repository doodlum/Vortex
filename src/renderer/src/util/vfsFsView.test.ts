import * as realFsModule from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  clearDeletions,
  install,
  onVirtualChange,
  overwriteEntriesUnder,
  realStat,
  rescanOverwrites,
  setAside,
  setOverwrite,
  setVirtualFiles,
  virtualSource,
} from "./vfsFsView";

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

  it("ghosts a plugin as a hard link did: the deployed file moves, the staged one stays", async () => {
    const changes: string[] = [];
    const stop = onVirtualChange((owner) => changes.push(owner));
    const deployed = path.join(game, "Data", "mod.esp");
    const ghosted = deployed + ".ghost";
    fs.renameSync(deployed, ghosted);
    expect(fs.existsSync(deployed)).toBe(false);
    expect(fs.readFileSync(ghosted, "utf8")).toBe("mod plugin");
    expect(fs.readdirSync(path.join(game, "Data")).sort()).toEqual(["mod.esp.ghost", "textures"]);
    expect(realFsModule.existsSync(path.join(staging, "mod.esp"))).toBe(true);
    // Vortex then renames the staged file too: the deployed one follows it.
    await fs.promises.rename(path.join(staging, "mod.esp"), path.join(staging, "mod.esp.ghost"));
    expect(fs.readFileSync(ghosted, "utf8")).toBe("mod plugin");
    expect(virtualSource(ghosted)).toBe(path.join(staging, "mod.esp.ghost"));
    // And back, through the callback form.
    await new Promise<void>((resolve, reject) =>
      fs.rename(ghosted, deployed, (err) => (err ? reject(err) : resolve())),
    );
    expect(fs.readFileSync(deployed, "utf8")).toBe("mod plugin");
    realFsModule.renameSync(path.join(staging, "mod.esp.ghost"), path.join(staging, "mod.esp"));
    expect(changes.length).toBeGreaterThanOrEqual(3);
    expect(new Set(changes)).toEqual(new Set(["game"]));
    stop();
  });

  it("follows a renamed mod folder in staging", () => {
    const moved = path.join(root, "staging", "Renamed");
    fs.renameSync(staging, moved);
    try {
      expect(fs.readFileSync(path.join(game, "Data", "textures", "x.dds"), "utf8")).toBe("texture");
      expect(virtualSource(path.join(game, "Data", "mod.esp"))).toBe(path.join(moved, "mod.esp"));
    } finally {
      realFsModule.renameSync(moved, staging);
    }
  });

  it("deletes a deployed file from the view only, sparing staging and the game's original", async () => {
    const original = path.join(game, "Data", "mod.esp");
    realFsModule.mkdirSync(path.dirname(original), { recursive: true });
    realFsModule.writeFileSync(original, "game original");
    try {
      // The deployed file is the mod's, over the original, as a link that replaced it was.
      expect(fs.readFileSync(original, "utf8")).toBe("mod plugin");
      fs.unlinkSync(original);
      expect(realFsModule.readFileSync(original, "utf8")).toBe("game original");
      expect(realFsModule.readFileSync(path.join(staging, "mod.esp"), "utf8")).toBe("mod plugin");
      expect(virtualSource(original)).toBeUndefined();
      // A folder only mods provide, removed the way fs-extra removes.
      await fs.promises.rm(path.join(game, "Data", "textures"), { recursive: true, force: true });
      expect(fs.existsSync(path.join(game, "Data", "textures"))).toBe(false);
      expect(realFsModule.existsSync(path.join(staging, "textures", "x.dds"))).toBe(true);
    } finally {
      realFsModule.rmSync(path.join(game, "Data"), { recursive: true, force: true });
    }
  });

  it("wraps a second module (Electron's original-fs) once, sharing its promises", async () => {
    // graceful-fs, fs-extra and rimraf read through original-fs (requireRemap).
    const other = {
      ...realFsModule,
      promises: fs.promises,
      Dirent: realFsModule.Dirent,
    } as typeof realFsModule;
    install(other);
    install(other);
    const deployed = path.join(game, "Data", "mod.esp");
    expect(other.readFileSync(deployed, "utf8")).toBe("mod plugin");
    expect(other.readdirSync(path.join(game, "Data")).sort()).toEqual(["mod.esp", "textures"]);
    expect(await other.promises.readFile(deployed, "utf8")).toBe("mod plugin");
    // The originals stay the first module's: the real disk has no such file.
    await expect(realStat(deployed)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("copies a deployed file from its staged file, and resolves its real path", async () => {
    const deployed = path.join(game, "Data", "mod.esp");
    const copy = path.join(root, "copied.esp");
    fs.copyFileSync(deployed, copy);
    expect(realFsModule.readFileSync(copy, "utf8")).toBe("mod plugin");
    await fs.promises.copyFile(deployed, copy);
    expect(fs.realpathSync(deployed)).toBe(path.resolve(deployed));
    expect(typeof fs.realpathSync.native).toBe("function");
    expect(await fs.promises.realpath(path.join(game, "Data", "textures"))).toBe(
      path.join(game, "Data", "textures"),
    );
    realFsModule.rmSync(copy);
  });

  it("keeps what wrapped functions carry, and lists Buffers and recursion as the disk does", async () => {
    const { promisify } = await import("node:util");
    expect(await promisify(fs.exists)(path.join(game, "Data", "mod.esp"))).toBe(true);
    expect(() => fs.readdirSync(path.join(game, "Data"), { encoding: "buffer" })).toThrow(/ENOENT/);
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

describe("what programs wrote inside a root", () => {
  const overwrite = path.join(root, "staging", "__vortex_vfs_overwrite", "game");
  const write = (rel: string, text: string) => {
    realFsModule.mkdirSync(path.dirname(path.join(overwrite, rel)), { recursive: true });
    realFsModule.writeFileSync(path.join(overwrite, rel), text);
  };
  beforeEach(() => {
    realFsModule.rmSync(overwrite, { recursive: true, force: true });
    // A tool's change to a mod's plugin, a file it made, and the game's own exe it deleted.
    write(path.join("Data", "mod.esp"), "edited by a tool");
    write(path.join("Data", "Output", "made.nif"), "generated");
    write(".wh.Game.exe", "");
    write(path.join("Data", ".cu.half-copied"), "in flight");
    setOverwrite(game, overwrite);
  });
  afterAll(() => setOverwrite(game, undefined));

  it("steps aside for a purge of real files, write layer included, and comes back", () => {
    // A link an older Vortex deployed where the view shows the mod's file.
    const linked = path.join(game, "Data", "mod.esp");
    realFsModule.mkdirSync(path.dirname(linked), { recursive: true });
    realFsModule.writeFileSync(linked, "left by links");
    const restore = setAside("game");
    expect(fs.readFileSync(linked, "utf8")).toBe("left by links");
    expect(fs.existsSync(path.join(game, "Game.exe"))).toBe(true);
    expect(fs.existsSync(path.join(game, "Data", "textures", "x.dds"))).toBe(false);
    fs.unlinkSync(linked);
    expect(realFsModule.existsSync(linked)).toBe(false);
    restore();
    restore();
    expect(fs.readFileSync(linked, "utf8")).toBe("edited by a tool");
    expect(fs.existsSync(path.join(game, "Game.exe"))).toBe(false);
    expect(fs.existsSync(path.join(game, "Data", "textures", "x.dds"))).toBe(true);
    realFsModule.rmSync(path.join(game, "Data"), { recursive: true, force: true });
  });

  it("is shown on top of the deployment, deletions included", () => {
    expect(fs.readFileSync(path.join(game, "Data", "mod.esp"), "utf8")).toBe("edited by a tool");
    expect(fs.readFileSync(path.join(game, "Data", "Output", "made.nif"), "utf8")).toBe(
      "generated",
    );
    expect(fs.readdirSync(path.join(game, "Data")).sort()).toEqual([
      "Output",
      "mod.esp",
      "textures",
    ]);
    // The exe a program deleted is gone from the view, never from the game folder.
    expect(fs.existsSync(path.join(game, "Game.exe"))).toBe(false);
    expect(fs.readdirSync(game)).toEqual(["Data"]);
    expect(() => fs.unlinkSync(path.join(game, "Game.exe"))).toThrow(/ENOENT/);
    fs.rmSync(path.join(game, "Game.exe"), { force: true });
    expect(realFsModule.readFileSync(path.join(game, "Game.exe"), "utf8")).toBe("real exe");
    expect(
      overwriteEntriesUnder(game)
        .map((e) => [path.relative(game, e.deployed).toLowerCase(), e.file !== undefined])
        .sort(),
    ).toEqual(
      [
        ["data\\mod.esp".replace(/\\/g, path.sep), true],
        [path.join("data", "output", "made.nif"), true],
        ["game.exe", false],
      ].sort(),
    );
  });

  it("imports a change into its mod by moving the written file over the staged one", () => {
    const deployed = path.join(game, "Data", "mod.esp");
    const staged = path.join(staging, "mod.esp");
    try {
      // What the External Changes dialog's import does: remove the staged file, move the
      // deployed one over it.
      realFsModule.rmSync(staged);
      fs.renameSync(deployed, staged);
      expect(realFsModule.readFileSync(staged, "utf8")).toBe("edited by a tool");
      expect(realFsModule.existsSync(path.join(overwrite, "Data", "mod.esp"))).toBe(false);
      expect(fs.readFileSync(deployed, "utf8")).toBe("edited by a tool");
    } finally {
      realFsModule.writeFileSync(staged, "mod plugin");
    }
  });

  it("reverts a change by deleting the written file, which shows the mod's own again", () => {
    const deployed = path.join(game, "Data", "mod.esp");
    fs.rmSync(deployed, { force: true });
    expect(realFsModule.existsSync(path.join(overwrite, "Data", "mod.esp"))).toBe(false);
    expect(fs.readFileSync(deployed, "utf8")).toBe("mod plugin");
    expect(realFsModule.readFileSync(path.join(staging, "mod.esp"), "utf8")).toBe("mod plugin");
  });

  it("moves a written file within the write folder while it stays inside the root", () => {
    fs.renameSync(
      path.join(game, "Data", "Output", "made.nif"),
      path.join(game, "Data", "Meshes", "made.nif"),
    );
    expect(realFsModule.existsSync(path.join(overwrite, "Data", "Meshes", "made.nif"))).toBe(true);
    expect(fs.readFileSync(path.join(game, "Data", "Meshes", "made.nif"), "utf8")).toBe(
      "generated",
    );
    expect(fs.existsSync(path.join(game, "Data", "Output", "made.nif"))).toBe(false);
  });

  it("puts a replacement of a deployed file in the write folder, as an atomic write does", () => {
    const deployed = path.join(game, "Data", "mod.esp");
    // writeFileAtomic: a temporary file elsewhere, renamed onto the target.
    const temp = path.join(root, "atomic.tmp");
    realFsModule.writeFileSync(temp, "atomically replaced");
    fs.renameSync(temp, deployed);
    expect(fs.readFileSync(deployed, "utf8")).toBe("atomically replaced");
    expect(realFsModule.existsSync(path.join(game, "Data", "mod.esp"))).toBe(false);
    expect(realFsModule.readFileSync(path.join(staging, "mod.esp"), "utf8")).toBe("mod plugin");
    // A copy onto it is the same.
    realFsModule.writeFileSync(temp, "copied over");
    fs.copyFileSync(temp, deployed);
    expect(fs.readFileSync(deployed, "utf8")).toBe("copied over");
    realFsModule.rmSync(temp);
  });

  it("writes a file a program deleted again, and new files into folders only mods provide", () => {
    const exe = path.join(game, "Game.exe");
    fs.writeFileSync(exe, "rewritten");
    expect(fs.readFileSync(exe, "utf8")).toBe("rewritten");
    expect(realFsModule.existsSync(path.join(overwrite, ".wh.Game.exe"))).toBe(false);
    expect(realFsModule.readFileSync(exe, "utf8")).toBe("real exe");
    // Data/textures exists only in the view; a new file there lands in the write folder.
    const made = path.join(game, "Data", "textures", "new.dds");
    fs.writeFileSync(made, "made by Vortex");
    expect(fs.readFileSync(made, "utf8")).toBe("made by Vortex");
    expect(fs.readdirSync(path.join(game, "Data", "textures")).sort()).toEqual([
      "new.dds",
      "x.dds",
    ]);
    expect(realFsModule.existsSync(path.join(game, "Data", "textures"))).toBe(false);
    // A real file is still written in place, and a real rename inside the game stays real.
    realFsModule.writeFileSync(path.join(game, "real.txt"), "real");
    fs.appendFileSync(path.join(game, "real.txt"), "!");
    expect(realFsModule.readFileSync(path.join(game, "real.txt"), "utf8")).toBe("real!");
    fs.renameSync(path.join(game, "real.txt"), path.join(game, "real2.txt"));
    expect(realFsModule.existsSync(path.join(game, "real2.txt"))).toBe(true);
    realFsModule.rmSync(path.join(game, "real2.txt"));
  });
  it("restores a deleted file when it is deployed again, and rereads the folder on request", () => {
    clearDeletions([path.join(game, "Game.exe")]);
    expect(realFsModule.existsSync(path.join(overwrite, ".wh.Game.exe"))).toBe(false);
    expect(fs.readFileSync(path.join(game, "Game.exe"), "utf8")).toBe("real exe");
    write("late.txt", "written while running");
    expect(fs.existsSync(path.join(game, "late.txt"))).toBe(false);
    rescanOverwrites();
    expect(fs.readFileSync(path.join(game, "late.txt"), "utf8")).toBe("written while running");
  });
});
