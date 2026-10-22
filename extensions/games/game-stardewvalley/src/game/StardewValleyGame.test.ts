import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { types } from "@nexusmods/vortex-api";
import { afterEach, expect, it, vi } from "vitest";

const install = vi.hoisted(() => ({ directory: "" }));
vi.mock("@nexusmods/vortex-api", () => ({
  fs: {},
  log: vi.fn(),
  util: {
    GameStoreHelper: { findByAppId: () => Promise.resolve({ gamePath: install.directory }) },
    getSafe: (state: unknown, keys: string[], fallback: unknown) =>
      keys.reduce(
        (value: unknown, key) =>
          value !== null && typeof value === "object"
            ? (value as Record<string, unknown>)[key]
            : undefined,
        state,
      ) ?? fallback,
  },
}));
vi.mock("../smapi/workflow", () => ({ downloadAndInstallSMAPI: vi.fn() }));
vi.mock("../smapi/selectors", () => ({ findSMAPIMod: vi.fn() }));
vi.mock("../smapi/lifecycle", () => ({ deploySMAPI: vi.fn() }));

import StardewValleyGame from "./StardewValleyGame";

afterEach(async () => {
  if (install.directory) await rm(install.directory, { recursive: true, force: true });
  install.directory = "";
});

it("discovers the Windows build and exposes matching game and SMAPI launch metadata", async () => {
  install.directory = await mkdtemp(path.join(os.tmpdir(), "stardew-discovery-"));
  await mkdir(path.join(install.directory, "Content"));
  await writeFile(path.join(install.directory, "Stardew Valley.exe"), "game fixture");
  const state = {
    settings: { gameMode: { discovered: { stardewvalley: { path: install.directory } } } },
  };
  const game = new StardewValleyGame({
    api: { getState: () => state },
  } as unknown as types.IExtensionContext);
  const discovered = await game.queryPath();
  expect(discovered).toBe(install.directory);
  if (typeof discovered !== "string") throw new Error("Expected a discovered install path");
  expect(game.executable(discovered)).toBe("Stardew Valley.exe");
  expect(path.join(discovered, game.executable(discovered))).toBe(
    path.join(install.directory, "Stardew Valley.exe"),
  );
  expect(game.supportedTools[0].executable(discovered)).toBe("StardewModdingAPI.exe");
  expect(game.supportedTools[0].requiredFiles).toEqual(["StardewModdingAPI.exe"]);
});
