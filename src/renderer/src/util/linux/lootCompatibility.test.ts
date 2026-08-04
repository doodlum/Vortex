import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  extensionNetwork,
  isLootWorker,
  linuxLootModule,
  linuxLootNativeModule,
  lootWorkerDirectory,
} from "./lootCompatibility";

describe.runIf(process.platform === "linux")("linuxLootModule", () => {
  const temporary: string[] = [];

  afterEach(() => {
    temporary.splice(0).forEach((entry) => fs.rmSync(entry, { force: true, recursive: true }));
  });

  it("keeps the stock API while resolving native paths and plugin spelling", () => {
    const gamePath = fs.mkdtempSync(path.join(os.tmpdir(), "vortex-loot-"));
    temporary.push(gamePath);
    fs.mkdirSync(path.join(gamePath, "Data"));
    fs.writeFileSync(path.join(gamePath, "Data", "Dragonborn.esm"), "plugin");
    const loadPlugins = vi.fn();
    const instance = { loadPlugins };
    const create = vi.fn((...args: unknown[]) => {
      const callback = args.at(-1) as (error: unknown, value: object) => void;
      callback(null, instance);
    });
    const source = { LootAsync: { create }, marker: true };

    const adapted = linuxLootModule(source);
    let result: any;
    adapted.LootAsync.create(
      "skyrimse",
      path.join(gamePath, "data", ".."),
      path.join(gamePath, "local"),
      "en",
      vi.fn(),
      vi.fn(),
      (_error, value) => {
        result = value;
      },
    );
    result.loadPlugins(["dragonborn.esm"], false, vi.fn());

    expect(adapted.marker).toBe(true);
    expect(create.mock.calls[0][1]).toBe(gamePath);
    expect(loadPlugins.mock.calls[0][0]).toEqual(["Dragonborn.esm"]);
  });

  it("recognizes only the stock LOOT worker entry point", () => {
    expect(isLootWorker("/extensions/gamebryo-plugin-management/dist/async.js")).toBe(true);
    expect(isLootWorker("/extensions/community/async.js")).toBe(false);
    expect(lootWorkerDirectory()).toBe(os.tmpdir());
  });

  it("adapts the native binding used by the bundled stock extension", () => {
    const gamePath = fs.mkdtempSync(path.join(os.tmpdir(), "vortex-loot-native-"));
    temporary.push(gamePath);
    fs.mkdirSync(path.join(gamePath, "Data"));
    fs.writeFileSync(path.join(gamePath, "Data", "Update.esm"), "plugin");

    class Loot {
      public gamePath: string;
      public loaded: string[] = [];
      constructor(_game: string, inputGamePath: string) {
        this.gamePath = inputGamePath;
      }
      public loadPlugins(names: string[]): void {
        this.loaded = names;
      }
    }

    const adapted = linuxLootNativeModule({ Loot });
    const loot = new adapted.Loot("skyrimse", path.join(gamePath, "data", ".."), gamePath) as Loot;
    loot.loadPlugins(["update.esm"]);

    expect(loot.gamePath).toBe(gamePath);
    expect(loot.loaded).toEqual(["Update.esm"]);
  });

  it("maps the stock Windows pipe name into the temporary directory", async () => {
    const compat = extensionNetwork(net);
    const server = new compat.Server();
    const pipeName = `\\\\?\\pipe\\loot-ipc-test-${process.pid}`;
    const expected = path.join(os.tmpdir(), pipeName);
    temporary.push(expected);

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(pipeName, resolve);
    });
    expect(server.address()).toBe(expected);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
