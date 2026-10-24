import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";

import { expect, vi } from "vitest";

// util/Steam reads paths at import time and there is no ApplicationData here
vi.mock("../../util/getVortexPath", () => ({ default: vi.fn(() => "/tmp") }));

import { makeRealDeploymentMethod } from "../../test-utils/builders";
import { makeDeployedGame } from "../../test-utils/deployedGame";
import { test } from "../../test-utils/harnessTest";
import hardlinkInit from "../hardlink_activator";
import VirtualDeployment, { VFS_DEPLOYMENT_ID } from "../vfs_deployment/VirtualDeployment";
import { METHOD_UPGRADED_NOTIFICATION_ID } from "./constants";
import { onGameModeActivated } from "./eventHandlers";
import { registerDeploymentMethod } from "./util/deploymentMethods";

// The virtual method claims support whatever the platform; what is under test is the move off
// a linking method, not aether-vfs.
const virtual = new VirtualDeployment(() => undefined);
registerDeploymentMethod(virtual);

test("a game deployed with hard links moves to the virtual file system, its folder restored", async () => {
  const game = await makeDeployedGame({ methodId: "hardlink_activator", stagingTag: true });
  const hardlink = makeRealDeploymentMethod(game.api, hardlinkInit);
  registerDeploymentMethod(hardlink);

  // A game original the mod replaces, so the link deployment backs it up.
  const original = path.join(game.dataPath, "ReplacedByMod.esp");
  mkdirSync(game.dataPath, { recursive: true });
  writeFileSync(original, "the game's own file");
  await game.deployMods(hardlink, ["ReplacedByMod"]);
  expect(statSync(original).nlink).toBeGreaterThan(1);
  expect(existsSync(`${original}.vortex_backup`)).toBe(true);

  onGameModeActivated(game.api, [virtual, hardlink], game.gameId);
  await vi.waitFor(() =>
    expect(game.dispatched).toContainEqual(
      expect.objectContaining({
        type: "SET_ACTIVATOR",
        payload: { gameId: game.gameId, activatorId: VFS_DEPLOYMENT_ID },
      }),
    ),
  );

  // The link purge restored the original and took the link away.
  expect(readFileSync(original, "utf8")).toBe("the game's own file");
  expect(statSync(original).nlink).toBe(1);
  expect(existsSync(`${original}.vortex_backup`)).toBe(false);
  // The game redeploys through the new method, and the user is told, not warned.
  expect(game.dispatched).toContainEqual(
    expect.objectContaining({
      type: "SET_NEED_DEPLOYMENT",
      payload: expect.objectContaining({ gameId: game.gameId, required: true }),
    }),
  );
  expect(game.notifications.map((n) => n.id)).toContain(METHOD_UPGRADED_NOTIFICATION_ID);
  expect(game.errorNotifications).toEqual([]);
});
