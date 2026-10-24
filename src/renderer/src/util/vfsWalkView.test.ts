import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { IEntry, IWalkOptions } from "turbowalk";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { setVirtualFiles } from "./vfsFsView";
import { viewWalk, wrapWalkModule } from "./vfsWalkView";

// A walk of the real disk with turbowalk's contract, so the test runs on every platform.
async function diskWalk(
  walkPath: string,
  progress: ((entries: IEntry[]) => void) | undefined,
  options?: IWalkOptions,
): Promise<void> {
  const entries: IEntry[] = [];
  const visit = (dir: string) => {
    for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
      const filePath = path.join(dir, dirent.name);
      const stats = fs.statSync(filePath);
      entries.push({
        filePath,
        isDirectory: dirent.isDirectory(),
        isReparsePoint: false,
        size: dirent.isDirectory() ? 0 : stats.size,
        mtime: Math.floor(stats.mtimeMs / 1000),
      });
      if (dirent.isDirectory() && options?.recurse !== false) visit(filePath);
    }
  };
  visit(walkPath);
  progress?.(entries);
}

const walk = viewWalk(diskWalk);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "vortex-vfs-walk-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const game = path.join(root, "Game");
const staging = path.join(root, "staging", "SomeMod");
fs.mkdirSync(path.join(game, "Data"), { recursive: true });
fs.mkdirSync(path.join(staging, "textures"), { recursive: true });
fs.writeFileSync(path.join(game, "Game.exe"), "real exe");
fs.writeFileSync(path.join(game, "Data", "Base.esm"), "original master");
fs.writeFileSync(path.join(staging, "Base.esm"), "replaced master, longer");
fs.writeFileSync(path.join(staging, "mod.esp"), "mod plugin");
fs.writeFileSync(path.join(staging, "textures", "x.dds"), "texture");
const modTime = new Date(2003, 2, 3);
fs.utimesSync(path.join(staging, "mod.esp"), modTime, modTime);

beforeEach(() =>
  setVirtualFiles(
    "game",
    [game],
    ["Base.esm", "mod.esp", path.join("textures", "x.dds")].map((rel) => ({
      deployed: path.join(game, "Data", rel),
      source: path.join(staging, rel),
    })),
  ),
);

async function listed(walkPath: string, options?: IWalkOptions) {
  const out: IEntry[] = [];
  await walk(walkPath, (entries) => out.push(...entries), options);
  return new Map(out.map((e) => [path.relative(walkPath, e.filePath), e]));
}

describe("turbowalk's view of a virtual deployment", () => {
  it("lists the served files and folders once, with the staged files' sizes and times", async () => {
    const entries = await listed(game);
    expect([...entries.keys()].sort()).toEqual(
      [
        "Data",
        path.join("Data", "Base.esm"),
        path.join("Data", "mod.esp"),
        path.join("Data", "textures"),
        path.join("Data", "textures", "x.dds"),
        "Game.exe",
      ].sort(),
    );
    expect(entries.get(path.join("Data", "Base.esm"))?.size).toBe("replaced master, longer".length);
    expect(entries.get(path.join("Data", "textures"))?.isDirectory).toBe(true);
    expect(entries.get(path.join("Data", "mod.esp"))?.mtime).toBe(
      Math.floor(modTime.getTime() / 1000),
    );
  });

  it("walks a folder only mods provide, and from above the game folder", async () => {
    expect([...(await listed(path.join(game, "Data", "textures"))).keys()]).toEqual(["x.dds"]);
    const fromAbove = await listed(root);
    expect(fromAbove.has(path.join("Game", "Data", "mod.esp"))).toBe(true);
    expect(fromAbove.has(path.join("staging", "SomeMod", "mod.esp"))).toBe(true);
  });

  it("keeps to direct children without recursion", async () => {
    expect([...(await listed(path.join(game, "Data"), { recurse: false })).keys()].sort()).toEqual([
      "Base.esm",
      "mod.esp",
      "textures",
    ]);
    expect([...(await listed(game, { recurse: false })).keys()].sort()).toEqual([
      "Data",
      "Game.exe",
    ]);
  });

  it("walks the real disk alone once the deployment is purged", async () => {
    setVirtualFiles("game", [game], []);
    expect([...(await listed(game)).keys()].sort()).toEqual(
      ["Data", path.join("Data", "Base.esm"), "Game.exe"].sort(),
    );
    expect((await listed(game)).get(path.join("Data", "Base.esm"))?.size).toBe(
      "original master".length,
    );
  });
});

describe("wrapWalkModule", () => {
  it("wraps a loaded turbowalk module once", async () => {
    const walkModule = { default: diskWalk };
    wrapWalkModule(walkModule);
    const once = walkModule.default;
    wrapWalkModule(walkModule);
    expect(walkModule.default).toBe(once);
    const seen: string[] = [];
    await walkModule.default(game, (entries) => seen.push(...entries.map((e) => e.filePath)));
    expect(seen).toContain(path.join(game, "Data", "mod.esp"));
  });
});
