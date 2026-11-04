import * as fs from "node:fs";
import { lstat, unlink } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import PromiseBB from "bluebird";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof fs.promises>("node:fs/promises");
  const mocked = { ...actual, lstat: vi.fn(actual.lstat), unlink: vi.fn(actual.unlink) };
  return { ...mocked, default: mocked };
});

import { purgeNativeHardlinks } from "./nativeHardlinks";

// Async functions retain the intrinsic native constructor even when the renderer global is Bluebird.
const NativePromise = (async () => undefined)().constructor as PromiseConstructor;

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(lstat).mockReset().mockImplementation(fs.promises.lstat);
  vi.mocked(unlink).mockReset().mockImplementation(fs.promises.unlink);
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vortex-native-purge-"));
  roots.push(root);
  const staging = path.join(root, "staging");
  const game = path.join(root, "game");
  fs.mkdirSync(staging);
  fs.mkdirSync(game);
  return { root, staging, game };
}

it("purges owned hardlinks including hidden files and preserves unrelated files and hardlinks", async () => {
  const h = fixture();
  for (const name of ["mod.ini", ".hidden"]) {
    const source = path.join(h.staging, name);
    fs.writeFileSync(source, "mod");
    fs.linkSync(source, path.join(h.game, name));
  }
  fs.writeFileSync(path.join(h.game, "base.ini"), "base");
  const external = path.join(h.root, "external.ini");
  fs.writeFileSync(external, "unowned");
  fs.linkSync(external, path.join(h.game, "unowned.ini"));

  await purgeNativeHardlinks(h.staging, h.game);

  expect(fs.readdirSync(h.game).sort()).toEqual(["base.ini", "unowned.ini"]);
  expect(fs.readFileSync(path.join(h.game, "base.ini"), "utf8")).toBe("base");
  expect(fs.readFileSync(path.join(h.game, "unowned.ini"), "utf8")).toBe("unowned");
  expect(fs.readFileSync(path.join(h.staging, "mod.ini"), "utf8")).toBe("mod");
  expect(fs.statSync(path.join(h.staging, ".hidden")).nlink).toBe(1);
});

it.skipIf(process.platform === "win32")(
  "does not follow directory symlinks while determining ownership",
  async () => {
    const h = fixture();
    const external = path.join(h.root, "external");
    fs.mkdirSync(external);
    fs.writeFileSync(path.join(external, "unowned.ini"), "unowned");
    fs.linkSync(path.join(external, "unowned.ini"), path.join(h.game, "unowned.ini"));
    fs.symlinkSync(external, path.join(h.staging, "outside"), "dir");

    await purgeNativeHardlinks(h.staging, h.game);

    expect(fs.readFileSync(path.join(h.game, "unowned.ini"), "utf8")).toBe("unowned");
  },
);

it("leaves the game intact when the staging directory is absent", async () => {
  const h = fixture();
  fs.writeFileSync(path.join(h.game, "base.ini"), "base");
  await purgeNativeHardlinks(path.join(h.root, "missing"), h.game);
  expect(fs.readFileSync(path.join(h.game, "base.ini"), "utf8")).toBe("base");
});

it.skipIf(process.platform === "win32")(
  "does not descend a destination directory symlink to an owned hardlink elsewhere",
  async () => {
    const h = fixture();
    const source = path.join(h.staging, "mod.ini");
    fs.writeFileSync(source, "mod");
    const external = path.join(h.root, "external");
    fs.mkdirSync(external);
    fs.linkSync(source, path.join(external, "mod.ini"));
    const shortcut = path.join(h.game, "outside");
    fs.symlinkSync(external, shortcut, "dir");

    await purgeNativeHardlinks(h.staging, h.game);

    expect(fs.lstatSync(shortcut).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(external, "mod.ini"), "utf8")).toBe("mod");
  },
);

it.each(["native", "bluebird"] as const)(
  "propagates denied unlink with the %s Promise runtime, including Bluebird global",
  async (runtime) => {
    const h = fixture();
    const source = path.join(h.staging, "mod.ini");
    const target = path.join(h.game, "mod.ini");
    fs.writeFileSync(source, "staged mod");
    fs.linkSync(source, target);
    const denied = Object.assign(new Error("unlink denied"), { code: "EACCES" });
    vi.mocked(unlink).mockRejectedValueOnce(denied);
    vi.stubGlobal("Promise", runtime === "bluebird" ? PromiseBB : NativePromise);
    try {
      await expect(purgeNativeHardlinks(h.staging, h.game)).rejects.toMatchObject({
        errors: [denied],
      });
      expect(fs.readFileSync(target, "utf8")).toBe("staged mod");
      expect(fs.statSync(source).nlink).toBe(2);
    } finally {
      vi.unstubAllGlobals();
    }
  },
);
it.each(["native", "bluebird"] as const)(
  "refuses an incomplete staging ownership scan with the %s Promise runtime",
  async (runtime) => {
    const h = fixture();
    const source = path.join(h.staging, "mod.ini");
    const target = path.join(h.game, "mod.ini");
    fs.writeFileSync(source, "staged mod");
    fs.linkSync(source, target);
    const failure = Object.assign(new Error("ownership scan failed"), { code: "EIO" });
    vi.mocked(lstat).mockRejectedValueOnce(failure);
    vi.stubGlobal("Promise", runtime === "bluebird" ? PromiseBB : NativePromise);
    try {
      await expect(purgeNativeHardlinks(h.staging, h.game)).rejects.toMatchObject({
        errors: [failure],
      });
      expect(unlink).not.toHaveBeenCalled();
      expect(fs.readFileSync(target, "utf8")).toBe("staged mod");
    } finally {
      vi.unstubAllGlobals();
    }
  },
);
