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
  makeDeployedFile,
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
import type { IRemoveModOptions } from "./types/IRemoveModOptions";
import { getAllActivators } from "./util/deploymentMethods";

// Async functions retain the intrinsic native constructor even when the renderer global is Bluebird.
const NativePromise = (async () => undefined)().constructor as PromiseConstructor;

const installManager = { markRecentRemoval: vi.fn() } as unknown as InstallManager;

/** Removes mods as the "remove-mods" event handler does. */
function removeMods(game: IDeployedGameHarness, modIds: string[], options?: IRemoveModOptions) {
  return new Promise<void>((resolve, reject) =>
    onRemoveMods(
      game.api,
      getAllActivators(),
      installManager,
      game.gameId,
      modIds,
      (err) => (err == null ? resolve() : reject(err)),
      options,
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

test.each([
  { runtime: "native", willBeReplaced: false },
  { runtime: "bluebird", willBeReplaced: false },
  { runtime: "native", willBeReplaced: true },
  { runtime: "bluebird", willBeReplaced: true },
] as const)(
  "removal retains finalized ownership with $runtime Promise, replacement=$willBeReplaced",
  async ({ runtime, willBeReplaced }) => {
    const methodId = `remaining-files-${runtime}`;
    const game = await makeRemovalGame(methodId);
    // The installation folder is deliberately different from the mod ID.
    const stage = path.join(game.stagingPath, "installed-folder");
    await mkdir(stage, { recursive: true });
    await mkdir(game.dataPath, { recursive: true });
    const payload = path.join(stage, "payload.txt");
    const deployed = path.join(game.dataPath, "payload.txt");
    await writeFile(payload, "retained mod bytes");
    await nodeFs.promises.link(payload, deployed);
    game.setState((draft) => {
      draft.persistent.mods[game.gameId].Requested = makeMod({
        id: "Requested",
        installationPath: "installed-folder",
      });
    });
    const remaining = makeDeployedFile({
      relPath: "payload.txt",
      source: "installed-folder",
    });
    await game.saveManifest([remaining], methodId);
    const method = makeDeploymentMethod({
      id: methodId,
      prepare: async () => undefined,
      deactivate: async () => undefined,
      // LinkingDeployment can report a per-file failure without rejecting finalize.
      finalize: async () => [remaining],
    });
    registerTestDeploymentMethod(method);
    vi.stubGlobal("Promise", runtime === "bluebird" ? PromiseBB : NativePromise);
    try {
      const failure = await removeMods(game, ["Requested"], { willBeReplaced }).catch(
        (err: unknown) => err,
      );
      expect(failure).toBeInstanceOf(Error);
      expect(nodeFs.readFileSync(payload, "utf8")).toBe("retained mod bytes");
      expect(nodeFs.readFileSync(deployed, "utf8")).toBe("retained mod bytes");
      expect(game.getState().persistent.mods[game.gameId].Requested).toBeDefined();
      expect(await game.recordedFiles()).toEqual(["payload.txt"]);
    } finally {
      vi.unstubAllGlobals();
    }
  },
);

test("ownership belonging to another mod does not prevent successful removal", async () => {
  const methodId = "other-mod-remains";
  const game = await makeRemovalGame(methodId);
  for (const id of ["Requested", "Other"]) {
    await mkdir(path.join(game.stagingPath, id), { recursive: true });
    await writeFile(path.join(game.stagingPath, id, "payload.txt"), id);
  }
  game.setState((draft) => {
    draft.persistent.mods[game.gameId] = {
      Requested: makeMod({ id: "Requested", installationPath: "Requested" }),
      Other: makeMod({ id: "Other", installationPath: "Other" }),
    };
  });
  await mkdir(game.dataPath, { recursive: true });
  await writeFile(path.join(game.dataPath, "other.txt"), "Other");
  const remaining = makeDeployedFile({ relPath: "other.txt", source: "Other" });
  registerTestDeploymentMethod(
    makeDeploymentMethod({
      id: methodId,
      prepare: async () => undefined,
      deactivate: async () => undefined,
      finalize: async () => [remaining],
    }),
  );
  await removeMods(game, ["Requested"]);
  expect(nodeFs.existsSync(path.join(game.stagingPath, "Requested"))).toBe(false);
  expect(game.getState().persistent.mods[game.gameId].Requested).toBeUndefined();
  expect(nodeFs.readFileSync(path.join(game.stagingPath, "Other", "payload.txt"), "utf8")).toBe(
    "Other",
  );
  expect(game.getState().persistent.mods[game.gameId].Other).toBeDefined();
  expect(await game.recordedFiles()).toEqual(["other.txt"]);
});

test.each(["native", "bluebird"] as const)(
  "a rejected deactivation waits for its same-type peers with %s Promise",
  async (runtime) => {
    const methodId = `same-type-held-${runtime}`;
    const game = await makeRemovalGame(methodId);
    game.setState((draft) => {
      draft.persistent.mods[game.gameId] = Object.fromEntries(
        ["Broken", "Slow", "Next"].map((id) => [id, makeMod({ id, installationPath: id })]),
      );
    });
    for (const id of ["Broken", "Slow", "Next"]) {
      await mkdir(path.join(game.stagingPath, id), { recursive: true });
      await writeFile(path.join(game.stagingPath, id, "payload.txt"), id);
    }
    let releaseSlow: () => void;
    const held = new NativePromise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const started: string[] = [];
    const prepare = vi.fn(async () => undefined);
    const cancel = vi.fn();
    registerTestDeploymentMethod(
      makeDeploymentMethod({
        id: methodId,
        prepare,
        deactivate: async (source) => {
          const id = path.basename(source);
          started.push(id);
          if (id === "Broken") throw new Error("broken same-type mod");
          if (id === "Slow") await held;
        },
        finalize: async () => [],
        cancel,
      }),
    );
    vi.stubGlobal("Promise", runtime === "bluebird" ? PromiseBB : NativePromise);
    try {
      const failing = removeMods(game, ["Broken", "Slow"]).catch((err: unknown) => err);
      const next = removeMods(game, ["Next"]);
      await vi.waitFor(() => expect(started).toContain("Slow"));
      await settle(100);
      const prepareCountBeforeRelease = prepare.mock.calls.length;
      const cancelCountBeforeRelease = cancel.mock.calls.length;
      releaseSlow();
      const [failure] = await Promise.all([failing, next]);
      expect((failure as Error).message).toBe("broken same-type mod");
      expect(prepareCountBeforeRelease).toBe(1);
      expect(cancelCountBeforeRelease).toBe(0);
      for (const id of ["Broken", "Slow"]) {
        expect(nodeFs.readFileSync(path.join(game.stagingPath, id, "payload.txt"), "utf8")).toBe(
          id,
        );
        expect(game.getState().persistent.mods[game.gameId][id]).toBeDefined();
      }
      expect(nodeFs.existsSync(path.join(game.stagingPath, "Next"))).toBe(false);
    } finally {
      releaseSlow?.();
      vi.unstubAllGlobals();
    }
  },
);

test.each(["native", "bluebird"] as const)(
  "removal waits for asynchronous cancellation with %s Promise",
  async (runtime) => {
    const methodId = `held-cancel-${runtime}`;
    const game = await makeRemovalGame(methodId);
    game.setState((draft) => {
      draft.persistent.mods[game.gameId] = Object.fromEntries(
        ["Broken", "Next"].map((id) => [id, makeMod({ id, installationPath: id })]),
      );
    });
    let releaseCancel: () => void;
    const held = new NativePromise<void>((resolve) => {
      releaseCancel = resolve;
    });
    const prepare = vi.fn(async () => undefined);
    const cancel = vi.fn(() => held);
    registerTestDeploymentMethod(
      makeDeploymentMethod({
        id: methodId,
        prepare,
        cancel,
        deactivate: async (source) => {
          if (path.basename(source) === "Broken") throw new Error("cancelled broken mod");
        },
        finalize: async () => [],
      }),
    );
    vi.stubGlobal("Promise", runtime === "bluebird" ? PromiseBB : NativePromise);
    try {
      let completed = false;
      const failing = removeMods(game, ["Broken"]).catch((err: unknown) => {
        completed = true;
        return err;
      });
      const next = removeMods(game, ["Next"]);
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
      await settle(100);
      const completedBeforeRelease = completed;
      const preparedBeforeRelease = prepare.mock.calls.length;
      releaseCancel();
      const [failure] = await Promise.all([failing, next]);
      expect((failure as Error).message).toBe("cancelled broken mod");
      expect(completedBeforeRelease).toBe(false);
      expect(preparedBeforeRelease).toBe(1);
    } finally {
      releaseCancel?.();
      vi.unstubAllGlobals();
    }
  },
);

test.each(["ENOENT", "ENOTFOUND"])(
  "explicit missing-mod Ignore recovery still permits removal for %s",
  async (code) => {
    const methodId = `missing-mod-${code}`;
    const game = await makeRemovalGame(methodId);
    game.setState((draft) => {
      draft.persistent.mods[game.gameId].Missing = makeMod({
        id: "Missing",
        installationPath: "Missing",
      });
    });
    registerTestDeploymentMethod(
      makeDeploymentMethod({
        id: methodId,
        prepare: async () => undefined,
        deactivate: async () => {
          throw Object.assign(new Error("missing mod"), { code });
        },
        cancel: async () => undefined,
        finalize: async () => [],
      }),
    );
    game.setNextDialog({ action: "Ignore", input: {} });
    await removeMods(game, ["Missing"]);
    expect(game.getState().persistent.mods[game.gameId].Missing).toBeUndefined();
  },
);
