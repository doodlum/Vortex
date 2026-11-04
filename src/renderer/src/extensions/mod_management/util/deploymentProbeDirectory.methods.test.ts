import * as nodeFs from "node:fs";
import * as path from "node:path";

import { expect, vi } from "vitest";

import { test } from "../../../test-utils/deploymentTest";
import type * as utilFs from "../../../util/fs";
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
