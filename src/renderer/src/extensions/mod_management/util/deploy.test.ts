import { writeFile } from "node:fs/promises";
import * as path from "node:path";

import { expect, vi } from "vitest";

// util/Steam reads paths at import time and there is no ApplicationData here
vi.mock("../../../util/getVortexPath", () => ({ default: vi.fn(() => "/tmp") }));

import { makeDeploymentMethod } from "../../../test-utils/builders";
import { makeHalfPurgedGame } from "../../../test-utils/deployedGame";
import { test } from "../../../test-utils/harnessTest";
import { ProcessCanceled } from "../../../util/CustomErrors";
import { deploymentReducer } from "../reducers/deployment";
import { purgeMods, purgeModsInPath } from "./deploy";
import { registerDeploymentMethod } from "./deploymentMethods";
import { registerDeploymentPreparation } from "./deploymentPreparation";

// a method whose purge removes nothing
const leavingMethod = makeDeploymentMethod({
  id: "leaving-method",
  externalChanges: () => Promise.resolve([]),
});
registerDeploymentMethod(leavingMethod);

// a method whose purge is cancelled before it removes anything
const cancelingMethod = makeDeploymentMethod({
  id: "canceling-method",
  externalChanges: () => Promise.resolve([]),
  prePurge: () => Promise.reject(new ProcessCanceled("canceled")),
});
registerDeploymentMethod(cancelingMethod);

const withDeploymentState = {
  extraReducers: [{ path: ["persistent", "deployment"], reducer: deploymentReducer }],
};

test("purging keeps the files the purge left in the manifest", async () => {
  const game = await makeHalfPurgedGame(leavingMethod.id);

  await purgeMods(game.api, game.gameId);

  expect(await game.recordedFiles()).toEqual(["left-behind.esp"]);
});

test("purging one mod type's folder keeps the files the purge left in its manifest", async () => {
  const game = await makeHalfPurgedGame(leavingMethod.id);

  await purgeModsInPath(game.api, game.gameId, "", game.dataPath);

  expect(await game.recordedFiles()).toEqual(["left-behind.esp"]);
});

test("purging one mod type's folder goes ahead over a damaged manifest", async () => {
  const game = await makeHalfPurgedGame(leavingMethod.id);
  await writeFile(path.join(game.dataPath, "vortex.deployment.json"), '{"damaged');

  await purgeModsInPath(game.api, game.gameId, "", game.dataPath);

  expect(game.dialogCalls).toEqual([]);
});

test("purging marks the game as purged", async () => {
  const game = await makeHalfPurgedGame(leavingMethod.id, withDeploymentState);
  const release = vi.fn(async (_succeeded: boolean) => undefined);
  const unregister = registerDeploymentPreparation(async () => release);
  try {
    await purgeMods(game.api, game.gameId);
    expect(release).toHaveBeenCalledExactlyOnceWith(true);
    expect(game.api.getState().persistent.deployment.purged[game.gameId]).toBe(true);
  } finally {
    unregister();
  }
});

test("a cancelled purge doesn't mark the game as purged", async () => {
  const game = await makeHalfPurgedGame(cancelingMethod.id, withDeploymentState);
  const manifest = await game.recordedFiles();
  const release = vi.fn(async (_succeeded: boolean) => undefined);
  const unregister = registerDeploymentPreparation(async () => release);
  try {
    await purgeMods(game.api, game.gameId);
    expect(release).toHaveBeenCalledExactlyOnceWith(false);
    expect(await game.recordedFiles()).toEqual(manifest);
    expect(game.api.getState().persistent.deployment.purged[game.gameId]).toBeFalsy();
  } finally {
    unregister();
  }
});

test("a cancelled purge preserves a preparation cleanup failure", async () => {
  const game = await makeHalfPurgedGame(cancelingMethod.id, withDeploymentState);
  const cleanupError = new ProcessCanceled("remount failed");
  const unregister = registerDeploymentPreparation(async () => async () => {
    throw cleanupError;
  });
  try {
    await expect(purgeMods(game.api, game.gameId)).rejects.toBe(cleanupError);
  } finally {
    unregister();
  }
});

test("a failed preparation stops core purge before methods, events or manifests change", async () => {
  const game = await makeHalfPurgedGame(leavingMethod.id, withDeploymentState);
  const manifest = await game.recordedFiles();
  const purge = vi.spyOn(leavingMethod, "purge");
  const prepare = vi.fn(async () => {
    throw new Error("the mount did not unmount");
  });
  const unregister = registerDeploymentPreparation(prepare);
  try {
    await expect(purgeMods(game.api, game.gameId)).rejects.toThrow("did not unmount");
    expect(purge).not.toHaveBeenCalled();
    expect(await game.recordedFiles()).toEqual(manifest);
    expect(game.api.getState().persistent.deployment.purged[game.gameId]).toBeFalsy();
  } finally {
    unregister();
    purge.mockRestore();
  }
  await purgeMods(game.api, game.gameId);
  expect(game.api.getState().persistent.deployment.purged[game.gameId]).toBe(true);
});

test("a failed preparation also stops single-target purge", async () => {
  const game = await makeHalfPurgedGame(leavingMethod.id);
  const manifest = await game.recordedFiles();
  const purge = vi.spyOn(leavingMethod, "purge");
  const unregister = registerDeploymentPreparation(async () => {
    throw new Error("still mounted");
  });
  try {
    await expect(purgeModsInPath(game.api, game.gameId, "", game.dataPath)).rejects.toThrow(
      "still mounted",
    );
    expect(purge).not.toHaveBeenCalled();
    expect(await game.recordedFiles()).toEqual(manifest);
  } finally {
    unregister();
    purge.mockRestore();
  }
});
