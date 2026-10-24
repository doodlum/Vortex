import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The helper runs for real, as a separate Node process, with a fake addon that records what it
// is asked to do.
const fakes = vi.hoisted(() => ({
  root: "",
  roots: [] as Array<{ location: string; files: unknown[] }>,
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

vi.mock("../../util/getVortexPath", () => ({ default: () => fakes.root }));
vi.mock("./aether", () => ({
  loadAether: () => ({ dir: fakes.root, addon: path.join(fakes.root, "fake-addon.cjs") }),
}));
vi.mock("./roots", () => ({
  deploymentForGame: () => Promise.resolve({ deployments: [] }),
  gameRoots: () => fakes.roots,
}));

import type { IExtensionApi } from "../../types/IExtensionContext";
import { isMounted, mountGame, unmountGame } from "./mounts";

const platform = process.platform;
beforeAll(() => {
  Object.defineProperty(process, "platform", { value: "linux" });
  fakes.root = fs.mkdtempSync(path.join(os.tmpdir(), "vfs-mounts-"));
  fs.writeFileSync(path.join(fakes.root, "fake-addon.cjs"), FAKE_ADDON);
});
afterAll(async () => {
  await Promise.all(["x", "y"].map((gameId) => unmountGame(gameId)));
  Object.defineProperty(process, "platform", { value: platform });
  fs.rmSync(fakes.root, { recursive: true, force: true });
});

const helperDir = (gameId: string) => path.join(fakes.root, "vfs-mounts", gameId);
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
  const errors: unknown[] = [];
  const api = {
    showErrorNotification: (...args: unknown[]) => errors.push(args),
  } as unknown as IExtensionApi;

  it("mounts through a helper that follows changes and ends on unmount", async () => {
    fakes.roots = [{ location: "/games/x", files: [] }];
    await mountGame(api, "x");
    expect(isMounted("x")).toBe(true);
    expect(calls("x")).toEqual(["new /games/x", "start"]);
    const pid = helperPid("x");

    // A new deployment of the same folders is swapped in by the running helper.
    fakes.roots = [{ location: "/games/x", files: [{}] }];
    await mountGame(api, "x");
    expect(calls("x").slice(2)).toEqual(["setRoot 0 1"]);
    expect(helperPid("x")).toBe(pid);

    // Other folders are mounted afresh.
    fakes.roots = [{ location: "/games/x2", files: [] }];
    await mountGame(api, "x");
    expect(calls("x").slice(3)).toEqual(["close", "new /games/x2", "start"]);

    await unmountGame("x");
    expect(isMounted("x")).toBe(false);
    expect(calls("x").at(-1)).toBe("close");
    expect(alive(pid)).toBe(false);
    expect(fs.existsSync(path.join(helperDir("x"), "status.json"))).toBe(false);
  }, 30000);

  it("reports a mount that fails", async () => {
    fakes.roots = [{ location: "/games/broken", files: [] }];
    await mountGame(api, "y");
    expect(isMounted("y")).toBe(false);
    expect(errors).toHaveLength(1);
    await unmountGame("y");
  }, 30000);

  it("takes a status nobody keeps fresh for a dead helper", () => {
    fs.mkdirSync(helperDir("z"), { recursive: true });
    const status = path.join(helperDir("z"), "status.json");
    fs.writeFileSync(status, JSON.stringify({ pid: 1, generation: 1, mounted: true }));
    expect(isMounted("z")).toBe(true);
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(status, old, old);
    expect(isMounted("z")).toBe(false);
  });
});
