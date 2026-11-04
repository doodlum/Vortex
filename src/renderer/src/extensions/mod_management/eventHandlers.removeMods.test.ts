import * as nodeFs from "node:fs";

import PromiseBB from "bluebird";
import { expect, vi } from "vitest";

// util/Steam reads paths at import time and there is no ApplicationData here
vi.mock("../../util/getVortexPath", () => ({ default: vi.fn(() => "/tmp") }));

import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";

import { settle } from "../../test-utils/async";
import {
  makeDeploymentMethod,
  makeMod,
  makeRealDeploymentMethod,
  registerTestDeploymentMethod,
  registerTestModType,
} from "../../test-utils/builders";
import { makeDeployedGame } from "../../test-utils/deployedGame";
import { test } from "../../test-utils/harnessTest";
import type { IDeployedGameHarness } from "../../test-utils/harnessTypes";
import hardlinkInit from "../hardlink_activator";
import { onRemoveMods } from "./eventHandlers";
import type InstallManager from "./InstallManager";
import { sessionReducer } from "./reducers/session";
import { getAllActivators } from "./util/deploymentMethods";

// Async functions retain the intrinsic native constructor even when the renderer global is Bluebird.
const NativePromise = (async () => undefined)().constructor as PromiseConstructor;

const installManager = { markRecentRemoval: vi.fn() } as unknown as InstallManager;

/** Removes mods as the "remove-mods" event handler does. */
function removeMods(game: IDeployedGameHarness, modIds: string[]) {
  return new Promise<void>((resolve, reject) =>
    onRemoveMods(game.api, getAllActivators(), installManager, game.gameId, modIds, (err) =>
      err == null ? resolve() : reject(err),
    ),
  );
}

async function makeRemovalGame(methodId: string): Promise<IDeployedGameHarness> {
  const game = await makeDeployedGame({
    methodId,
    extraReducers: [{ path: ["session", "mods"], reducer: sessionReducer }],
  });
  // no last active profile, so removal skips disabling the mods
  game.setState((draft) => {
    draft.settings.profiles.lastActiveProfile = {};
  });
  return game;
}

test("mods removed at the same time are all gone from the deployment manifest", async () => {
  const game = await makeRemovalGame("hardlink_activator");
  const method = makeRealDeploymentMethod(game.api, hardlinkInit);
  registerTestDeploymentMethod(method);
  await game.deployMods(method, ["First", "Second"]);

  await Promise.all([removeMods(game, ["First"]), removeMods(game, ["Second"])]);

  expect(await game.recordedFiles()).toEqual([]);
});

test.each(["native", "bluebird"] as const)(
  "a rejected removal retains staging and waits for every type with %s Promise",
  async (runtime) => {
    const methodId = `held-method-${runtime}`;
    const typeId = `second-type-${runtime}`;
    const game = await makeRemovalGame(methodId);
    const secondTypePath = `${game.dataPath}-second`;
    await mkdir(secondTypePath, { recursive: true });
    registerTestModType(typeId, secondTypePath);
    game.setState((draft) => {
      draft.persistent.mods[game.gameId] = {
        Broken: makeMod({ id: "Broken", installationPath: "Broken" }),
        Slow: makeMod({ id: "Slow", installationPath: "Slow", type: typeId }),
        Next: makeMod({ id: "Next", installationPath: "Next" }),
      };
    });
    let releaseSlow: () => void;
    const slowHeld = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const preparedPaths: string[] = [];
    const finalizedPaths: string[] = [];
    const method = makeDeploymentMethod({
      id: methodId,
      prepare: (dataPath) => {
        preparedPaths.push(dataPath);
        return Promise.resolve();
      },
      deactivate: (sourcePath) =>
        path.basename(sourcePath) === "Broken"
          ? Promise.reject(new Error("broken mod"))
          : Promise.resolve(),
      finalize: async (_gameId, dataPath) => {
        finalizedPaths.push(dataPath);
        if (dataPath === secondTypePath) {
          await slowHeld;
        }
        return [];
      },
    });
    registerTestDeploymentMethod(method);

    for (const id of ["Broken", "Slow", "Next"]) {
      await mkdir(path.join(game.stagingPath, id), { recursive: true });
      await writeFile(path.join(game.stagingPath, id, "payload.txt"), id);
    }
    vi.stubGlobal("Promise", runtime === "bluebird" ? PromiseBB : NativePromise);
    try {
      const failing = removeMods(game, ["Broken", "Slow"]).catch((err: unknown) => err);
      const next = removeMods(game, ["Next"]);
      await vi.waitFor(() => expect(finalizedPaths).toContain(secondTypePath));
      await settle(100);
      // mod types prepare concurrently, so their order is not fixed
      const preparedBeforeRelease = [...preparedPaths].sort();
      releaseSlow();
      const [failure] = await Promise.all([failing, next]);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe("broken mod");
      for (const id of ["Broken", "Slow"]) {
        expect(nodeFs.readFileSync(path.join(game.stagingPath, id, "payload.txt"), "utf8")).toBe(
          id,
        );
        expect(game.getState().persistent.mods[game.gameId][id]).toBeDefined();
      }
      expect(nodeFs.existsSync(path.join(game.stagingPath, "Next"))).toBe(false);

      expect(preparedBeforeRelease).toEqual([game.dataPath, secondTypePath].sort());
    } finally {
      releaseSlow?.();
      vi.unstubAllGlobals();
    }
  },
);
