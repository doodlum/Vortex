import * as nodeFs from "node:fs";
import * as path from "node:path";

import { expect, vi } from "vitest";

import { test } from "../../../test-utils/deploymentTest";
import * as utilFs from "../../../util/fs";
import { getGame } from "../../gamemode_management/util/getGame";
import {
  getAllActivators,
  getCurrentActivator,
  registerDeploymentMethod,
} from "./deploymentMethods";

vi.mock("../../../util/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof utilFs>();
  return {
    ...actual,
    accessSync: vi.fn(actual.accessSync),
    symlinkSync: (_source: string, dest: string) => nodeFs.writeFileSync(dest, "probe"),
  };
});

test.for(["hardlink", "symlink", "move"] as const)(
  "%s: selection survives a missing registered root but refuses a removed game",
  async (method, { makeDeployment }) => {
    const gameId = "probe-game";
    const h = makeDeployment({ files: { "content.json": "mod" }, method, gameId });
    const gamePath = path.dirname(h.gameDir);
    const missing = path.join(gamePath, "Missing", "Mods");
    const game = getGame(gameId);
    const original = game.getModPaths;
    game.getModPaths = () => ({ "": missing, root: gamePath });
    const state = {
      settings: {
        gameMode: { discovered: { [gameId]: { path: gamePath } } },
        mods: { installPath: { [gameId]: h.stagingDir }, activator: { [gameId]: h.method.id } },
      },
    } as any;
    const activators = getAllActivators();
    const previous = [...activators];
    activators.splice(0);
    registerDeploymentMethod(h.method);
    vi.stubGlobal("process", { ...process, platform: "linux" });
    try {
      expect(getCurrentActivator(state, gameId, false)).toBe(h.method);
      expect(nodeFs.existsSync(missing)).toBe(false);
      expect(nodeFs.readdirSync(gamePath)).toEqual(["Data"]);
      state.settings.gameMode.discovered[gameId].path = path.join(gamePath, "RemovedGame");
      expect(getCurrentActivator(state, gameId, false)).toBeUndefined();
      expect(nodeFs.existsSync(state.settings.gameMode.discovered[gameId].path)).toBe(false);
    } finally {
      game.getModPaths = original;
      activators.splice(0, activators.length, ...previous);
      vi.unstubAllGlobals();
    }
  },
);

test.for(["hardlink", "symlink", "move"] as const)(
  "%s: refuses a staging root whose access check fails",
  async (method, { makeDeployment }) => {
    const gameId = "staging-probe-game";
    const h = makeDeployment({ files: { "content.json": "mod" }, method, gameId });
    const gamePath = path.dirname(h.gameDir);
    const state = {
      settings: {
        gameMode: { discovered: { [gameId]: { path: gamePath } } },
        mods: { installPath: { [gameId]: h.stagingDir }, activator: { [gameId]: h.method.id } },
      },
    } as any;
    const access = vi.mocked(utilFs.accessSync);
    expect(h.method.isSupported(state, gameId, "")).toBeUndefined();
    try {
      for (const code of ["EACCES", "EROFS"]) {
        access.mockImplementation((target, mode) => {
          if (String(target) === h.stagingDir) {
            throw Object.assign(new Error("Inert staging-root access failure"), { code });
          }
          return nodeFs.accessSync(target, mode);
        });
        expect(h.method.isSupported(state, gameId, ""), code).toBeDefined();
      }
    } finally {
      access.mockImplementation(nodeFs.accessSync);
    }
    expect(h.method.isSupported(state, gameId, "")).toBeUndefined();
  },
);
