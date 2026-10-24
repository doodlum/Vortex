import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The helper runs for real, as a separate Node process, with a fake addon that records what it
// is asked to do.
const fakes = vi.hoisted(() => ({
  root: "",
  roots: [] as Array<{ location: string; files: unknown[] }>,
  version: "1.0.0",
}));

const FAKE_ADDON = `
const fs = require("fs");
const path = require("path");
const record = (dir, line) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, "calls.txt"), line + "\\n");
};
exports.Session = class {
  constructor(opts) {
    if (opts.roots[0].location.includes("broken")) throw new Error("E_MOUNT: fusermount3 failed");
    this.opts = opts;
    record(opts.stateDir, "new " + opts.roots.map((root) => root.location).join(","));
  }
  start() { record(this.opts.stateDir, "start"); }
  setRoot(id, root) { record(this.opts.stateDir, "setRoot " + id + " " + root.files.length); }
  close() { record(this.opts.stateDir, "close"); }
};
`;

vi.mock("../../util/getVortexPath", () => ({ default: () => path.join(fakes.root, "profile") }));
vi.mock("./aether", () => ({
  loadAether: () => ({ dir: fakes.root, addon: path.join(fakes.root, "fake-addon.cjs") }),
}));
vi.mock("../../util/application", () => ({ getApplication: () => ({ version: fakes.version }) }));
vi.mock("../gamemode_management/util/getGame", () => ({ getGame: () => ({ name: "Some Game" }) }));
vi.mock("./roots", () => ({
  deploymentForGame: () => Promise.resolve({ deployments: [] }),
  gameRoots: () => fakes.roots,
}));

import type { IExtensionApi } from "../../types/IExtensionContext";
import { flatpakHostPath, hostFusermountScript, isMounted, mountGame, unmountGame } from "./mounts";

const platform = process.platform;
beforeAll(() => {
  Object.defineProperty(process, "platform", { value: "linux" });
  fakes.root = fs.mkdtempSync(path.join(os.tmpdir(), "vfs-mounts-"));
  process.env.VORTEX_VFS_MOUNTS_DIR = path.join(fakes.root, "vfs-mounts");
  fs.writeFileSync(path.join(fakes.root, "fake-addon.cjs"), FAKE_ADDON);
  process.env.VORTEX_VFS_AUTOSTART_DIR = path.join(fakes.root, "autostart");
});
afterAll(async () => {
  await Promise.all(["x", "y"].map((gameId) => unmountGame(api, gameId)));
  delete process.env.VORTEX_VFS_MOUNTS_DIR;
  delete process.env.VORTEX_VFS_AUTOSTART_DIR;
  Object.defineProperty(process, "platform", { value: platform });
  fs.rmSync(fakes.root, { recursive: true, force: true });
});

const discovered: Record<string, { path: string }> = {
  x: { path: "/games/x" },
  y: { path: "/games/y" },
  z: { path: "/games/z" },
};
const api = {
  getState: () => ({ settings: { gameMode: { discovered } } }),
  showErrorNotification: (...args: unknown[]) => errors.push(args),
} as unknown as IExtensionApi;
const errors: unknown[] = [];
const helperDir = (gameId: string) =>
  path.join(
    fakes.root,
    "vfs-mounts",
    `${gameId}-${createHash("sha256").update(path.resolve(discovered[gameId].path)).digest("hex").slice(0, 16)}`,
  );
const calls = (gameId: string) =>
  fs
    .readFileSync(path.join(helperDir(gameId), "state", "calls.txt"), "utf8")
    .trim()
    .split("\n");
const helperPid = (gameId: string): number =>
  JSON.parse(fs.readFileSync(path.join(helperDir(gameId), "status.json"), "utf8")).pid;
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("the Linux mounts", () => {
  it("mounts through a helper that follows changes and ends on unmount", async () => {
    fakes.roots = [{ location: "/games/x", files: [] }];
    await mountGame(api, "x");
    expect(isMounted(api, "x")).toBe(true);
    expect(calls("x")).toEqual(["new /games/x", "start"]);
    const pid = helperPid("x");
    // Mounted again at login, as links survived a restart.
    const entry = path.join(
      fakes.root,
      "autostart",
      `vortex-vfs-${path.basename(helperDir("x"))}.desktop`,
    );
    expect(fs.readFileSync(entry, "utf8")).toMatch(
      /^Exec="env" "ELECTRON_RUN_AS_NODE=1" ".+" ".+helper\.cjs" ".+"$/m,
    );

    // A new deployment of the same folders is swapped in by the running helper.
    fakes.roots = [{ location: "/games/x", files: [{}] }];
    await mountGame(api, "x");
    expect(calls("x").slice(2)).toEqual(["setRoot 0 1"]);
    expect(helperPid("x")).toBe(pid);

    // Other folders are mounted afresh.
    fakes.roots = [{ location: "/games/x2", files: [] }];
    await mountGame(api, "x");
    expect(calls("x").slice(3)).toEqual(["close", "new /games/x2", "start"]);

    await unmountGame(api, "x");
    expect(isMounted(api, "x")).toBe(false);
    expect(fs.existsSync(entry)).toBe(false);
    expect(calls("x").at(-1)).toBe("close");
    expect(alive(pid)).toBe(false);
    expect(fs.existsSync(path.join(helperDir("x"), "status.json"))).toBe(false);
  }, 30000);

  it("replaces a helper another Vortex version started, whose addon stays loaded", async () => {
    fakes.roots = [{ location: "/games/x", files: [] }];
    await mountGame(api, "x");
    const pid = helperPid("x");
    fakes.version = "1.1.0";
    await mountGame(api, "x");
    expect(helperPid("x")).not.toBe(pid);
    expect(alive(pid)).toBe(false);
    expect(isMounted(api, "x")).toBe(true);
    fakes.version = "1.0.0";
    await unmountGame(api, "x");
  }, 30000);

  it("reports a mount that fails", async () => {
    fakes.roots = [{ location: "/games/broken", files: [] }];
    await mountGame(api, "y");
    expect(isMounted(api, "y")).toBe(false);
    expect(errors).toHaveLength(1);
    await unmountGame(api, "y");
  }, 30000);

  it("counts only this profile's live mount", () => {
    fs.mkdirSync(helperDir("z"), { recursive: true });
    const status = path.join(helperDir("z"), "status.json");
    const spec = path.join(helperDir("z"), "spec.json");
    fs.writeFileSync(status, JSON.stringify({ pid: 1, generation: 1, mounted: true }));
    fs.writeFileSync(spec, JSON.stringify({ owner: path.join(fakes.root, "other profile") }));
    expect(isMounted(api, "z")).toBe(false);
    fs.writeFileSync(spec, JSON.stringify({ owner: path.join(fakes.root, "profile") }));
    expect(isMounted(api, "z")).toBe(true);
    // A status nobody keeps fresh is a dead helper's.
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(status, old, old);
    expect(isMounted(api, "z")).toBe(false);
  });
});

describe("a Flatpak's host FUSE helper", () => {
  const info = [
    "[Application]",
    "name=com.nexusmods.vortex",
    "",
    "[Instance]",
    "app-path=/home/u/.local/share/flatpak/app/com.nexusmods.vortex/x86_64/stable/0123abcd/files",
    "",
  ].join("\n");

  it("finds an app file on the host through the branch's active commit", () => {
    expect(
      flatpakHostPath(
        info,
        "/app/main/resources/app.asar.unpacked/assets/aether-vfs/fusermount-relay",
      ),
    ).toBe(
      "/home/u/.local/share/flatpak/app/com.nexusmods.vortex/x86_64/stable/active/files/main/resources/app.asar.unpacked/assets/aether-vfs/fusermount-relay",
    );
    expect(flatpakHostPath(info, "/usr/bin/sh")).toBeUndefined();
    expect(flatpakHostPath("[Application]\n", "/app/x")).toBeUndefined();
  });

  it("mounts through the relay on the host, and unmounts with fusermount3", () => {
    const script = hostFusermountScript("/home/u/it's here/fusermount-relay");
    expect(script).toContain(
      `--forward-fd="$_FUSE_COMMFD" --env=_FUSE_COMMFD="$_FUSE_COMMFD" '/home/u/it'\\''s here/fusermount-relay' "$@"`,
    );
    expect(script).toContain('exec flatpak-spawn --host fusermount3 "$@"');
    expect(hostFusermountScript(undefined)).toContain('"$_FUSE_COMMFD" fusermount3 "$@"');
  });
});
