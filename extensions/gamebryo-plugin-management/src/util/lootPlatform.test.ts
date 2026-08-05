import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { lootWorkerDirectory, platformLootAsync } from "./lootPlatform";

const temporary: string[] = [];

afterEach(() => {
  temporary.splice(0).forEach((directory) => fs.rmSync(directory, { recursive: true }));
});

describe.runIf(process.platform === "linux")("LOOT Linux platform boundary", () => {
  it("passes the real filesystem casing to LOOT", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vortex-loot-"));
    temporary.push(root);
    const game = path.join(root, "Skyrim Special Edition");
    const local = path.join(root, "Local", "Skyrim Special Edition");
    fs.mkdirSync(game, { recursive: true });
    fs.mkdirSync(local, { recursive: true });
    const create = vi.fn();

    platformLootAsync({ create }).create(
      "skyrimse",
      path.join(root, "skyrim special edition"),
      path.join(root, "local", "skyrim special edition"),
    );

    expect(create).toHaveBeenCalledWith("skyrimse", game, local);
  });

  it("runs the worker from the Unix socket directory", () => {
    expect(lootWorkerDirectory()).toBe(os.tmpdir());
  });
});
