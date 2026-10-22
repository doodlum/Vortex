import path from "node:path";

import Bluebird from "bluebird";
import { beforeEach, describe, expect, it, vi } from "vitest";

// refreshMods reads the staging folder off disk. Drive it from an in-memory
// listing so each test can state exactly what the staging folder holds;
// a missing entry means the folder itself doesn't exist.
const stagingEntries = new Map<string, string[]>();
const createdDirs: string[] = [];
const removedPaths: string[] = [];
let afterStat: ((full: string) => Promise<void>) | undefined;

const enoent = () => Object.assign(new Error("ENOENT"), { code: "ENOENT" });

const stat = (full: string) => {
  if (stagingEntries.has(full)) {
    return Promise.resolve({ isDirectory: () => true, ctime: new Date(0) });
  }
  const sep = Math.max(full.lastIndexOf("\\"), full.lastIndexOf("/"));
  const dir = full.slice(0, sep);
  const name = full.slice(sep + 1);
  return (stagingEntries.get(dir) ?? []).includes(name)
    ? Promise.resolve({ isDirectory: () => true, ctime: new Date(0) })
    : Promise.reject(enoent());
};

vi.mock("../../../util/fs", () => ({
  ensureDirAsync: vi.fn((dir: string) => {
    createdDirs.push(dir);
    if (!stagingEntries.has(dir)) {
      stagingEntries.set(dir, []);
    }
    return Promise.resolve();
  }),
  readdirAsync: vi.fn((dir: string) => {
    const entries = stagingEntries.get(dir);
    return entries === undefined ? Promise.reject(enoent()) : Promise.resolve(entries);
  }),
  statAsync: vi.fn(async (full: string) => {
    const result = await stat(full);
    await afterStat?.(full);
    return result;
  }),
  statSilentAsync: vi.fn((full: string) => stat(full)),
  removeAsync: vi.fn((full: string) => {
    removedPaths.push(full);
    return Promise.resolve();
  }),
}));

vi.mock("../../../logging", () => {
  const log = vi.fn();
  return { default: log, log };
});

// only reached when the user declines the dialog; a real quit would kill the run
const quit = vi.fn();
vi.mock("../../../util/application", () => ({
  getApplication: () => ({ quit }),
}));

import { VortexError } from "@vortex/shared";

import { makeApiHarness, makeDownload, makeMod } from "../../../test-utils/builders";
import { addMod, removeMod, setModState } from "../actions/mods";
import type { IMod } from "../types/IMod";
import refreshMods from "./refreshMods";

const STAGING = "D:\\Vortex Mods\\skyrimse";
const GAME = "skyrimse";

/**
 * Drives refreshMods the way eventHandlers does: the staging folder holds
 * `onDisk`, state holds `knownMods`, and the user accepts the dialog. Removal
 * dispatches the real removeMod so the harness's real mods reducer applies it,
 * mirroring production rather than restating the outcome.
 */
function run(knownMods: Record<string, IMod>, onDisk: string[] | undefined, downloads = {}) {
  if (onDisk !== undefined) {
    stagingEntries.set(STAGING, onDisk);
  }
  const harness = makeApiHarness({ mods: { [GAME]: knownMods }, downloads });
  harness.setNextDialog({ action: "Apply Changes", input: {} });

  return refreshMods(
    harness.api,
    GAME,
    STAGING,
    knownMods,
    (mod: IMod) => harness.api.store.dispatch({ type: "ADD_MOD", payload: { gameId: GAME, mod } }),
    (modNames: string[]) => {
      modNames.forEach((name) => harness.api.store.dispatch(removeMod(GAME, name)));
    },
  ).then(() => harness);
}

describe("refreshMods", () => {
  beforeEach(() => {
    stagingEntries.clear();
    createdDirs.length = 0;
    removedPaths.length = 0;
    afterStat = undefined;
    quit.mockClear();
  });

  it("rebinds a mod whose archive reference went stale", async () => {
    const mods = {
      "Good Mod-1-0-0": makeMod({
        id: "Good Mod-1-0-0",
        installationPath: "Good Mod-1-0-0",
        archiveId: "goneId",
        attributes: { fileName: "GoodMod.7z" },
      }),
    };
    const downloads = { freshId: makeDownload({ id: "freshId", localPath: "GoodMod.7z" }) };

    const harness = await run(mods, ["Good Mod-1-0-0"], downloads);

    const mod = harness.getState().persistent.mods[GAME]["Good Mod-1-0-0"];
    expect(mod.archiveId).toBe("freshId");
    expect(mod.installationPath).toBe("Good Mod-1-0-0");
    expect(mod.state).toBe("installed");
  });

  it("leaves no record behind for a mod that vanished from the staging folder", async () => {
    // once removed the mod must stay removed: rebinding it to an archive
    // revives it as a record holding nothing but an archiveId.
    const mods = {
      "SkyUI_5_2_SE-12604-5-2SE": makeMod({
        id: "SkyUI_5_2_SE-12604-5-2SE",
        installationPath: "SkyUI_5_2_SE-12604-5-2SE",
        archiveId: "goneId",
        attributes: { fileName: "SkyUI.7z" },
      }),
      "Survivor-1-0-0": makeMod({
        id: "Survivor-1-0-0",
        installationPath: "Survivor-1-0-0",
      }),
    };
    const downloads = { freshId: makeDownload({ id: "freshId", localPath: "SkyUI.7z" }) };

    const harness = await run(mods, ["Survivor-1-0-0"], downloads);

    const remaining = harness.getState().persistent.mods[GAME];
    expect(remaining).not.toHaveProperty("SkyUI_5_2_SE-12604-5-2SE");
    expect(remaining).toHaveProperty("Survivor-1-0-0");
  });

  it("keeps every record when the staging folder reads empty", async () => {
    const mods = {
      "SkyUI_5_2_SE-12604-5-2SE": makeMod({
        id: "SkyUI_5_2_SE-12604-5-2SE",
        installationPath: "SkyUI_5_2_SE-12604-5-2SE",
      }),
    };

    const harness = await run(mods, [], {});

    expect(harness.getState().persistent.mods[GAME]).toHaveProperty("SkyUI_5_2_SE-12604-5-2SE");
  });

  it("refuses to reconcile when the staging folder is missing", async () => {
    // Creating it here would make every mod look deleted. A staging folder
    // that isn't there means unavailable (wrong drive, path not applied yet),
    // not emptied.
    const mods = {
      "SkyUI_5_2_SE-12604-5-2SE": makeMod({
        id: "SkyUI_5_2_SE-12604-5-2SE",
        installationPath: "SkyUI_5_2_SE-12604-5-2SE",
      }),
    };

    const err = await run(mods, undefined).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VortexError);
    expect((err as VortexError).data).toMatchObject({ kind: "fs:not-found", path: STAGING });
    expect(createdDirs).toEqual([]);
  });

  it("creates the staging folder on first run, when no mods are known", async () => {
    const harness = await run({}, undefined);

    expect(createdDirs).toEqual([STAGING]);
    expect(harness.dialogCalls).toEqual([]);
  });

  it("does not rebind an archive onto a mod it never knew", async () => {
    const harness = await run({}, [], {
      freshId: makeDownload({ id: "freshId", localPath: "SkyUI.7z" }),
    });

    expect(harness.getState().persistent.mods[GAME]).toEqual({});
  });
});

describe("refreshMods during concurrent installation", () => {
  beforeEach(() => {
    stagingEntries.clear();
    createdDirs.length = 0;
    removedPaths.length = 0;
    afterStat = undefined;
    quit.mockClear();
  });

  function begin(captured: Record<string, IMod>, onDisk: string[], current = captured) {
    stagingEntries.set(STAGING, onDisk);
    const harness = makeApiHarness({ mods: { [GAME]: current } });
    harness.setNextDialog({ action: "Apply Changes", input: {} });
    const add = vi.fn();
    const remove = vi.fn();
    const pending = refreshMods(harness.api, GAME, STAGING, captured, add, remove);
    return { harness, add, remove, pending };
  }
  const survivor = () => makeMod({ id: "survivor", installationPath: "survivor" });

  it("does not report an installation canceled while the directory scan is pending", async () => {
    const captured = {
      survivor: survivor(),
      canceled: makeMod({ id: "canceled", state: "installing" }),
    };
    const run = begin(captured, ["survivor"]);
    run.harness.api.store.dispatch(removeMod(GAME, "canceled"));
    await run.pending;
    expect(run.harness.dialogCalls).toEqual([]);
    expect(run.remove).not.toHaveBeenCalled();
  });

  it.each(["installing", "downloading"] as const)(
    "does not report a missing in-flight %s directory",
    async (state) => {
      const run = begin({ survivor: survivor(), active: makeMod({ id: "active", state }) }, [
        "survivor",
      ]);
      await run.pending;
      expect(run.harness.dialogCalls).toEqual([]);
      expect(run.remove).not.toHaveBeenCalled();
    },
  );

  it("does not treat an installation that finishes during the scan as an external removal", async () => {
    const run = begin(
      { survivor: survivor(), active: makeMod({ id: "active", state: "installing" }) },
      ["survivor"],
    );
    run.harness.api.store.dispatch(setModState(GAME, "active", "installed"));
    await run.pending;
    expect(run.harness.dialogCalls).toEqual([]);
    expect(run.remove).not.toHaveBeenCalled();
  });

  it("does not report removal when a known mod starts reinstalling during the scan", async () => {
    const run = begin(
      { survivor: survivor(), active: makeMod({ id: "active", state: "installed" }) },
      ["survivor"],
    );
    run.harness.api.store.dispatch(setModState(GAME, "active", "installing"));
    await run.pending;
    expect(run.harness.dialogCalls).toEqual([]);
    expect(run.remove).not.toHaveBeenCalled();
  });

  it("does not rediscover an installation registered while the directory scan is pending", async () => {
    const run = begin({ survivor: survivor() }, ["survivor", "newmod.installing"]);
    run.harness.api.store.dispatch(addMod(GAME, makeMod({ id: "newmod", state: "installing" })));
    await run.pending;
    expect(run.harness.dialogCalls).toEqual([]);
    expect(run.add).not.toHaveBeenCalled();
    expect(run.harness.getState().persistent.mods[GAME].newmod.state).toBe("installing");
  });

  it("does not re-add a canceled mod from a stale directory listing", async () => {
    const captured = {
      survivor: survivor(),
      canceled: makeMod({ id: "canceled", state: "installing" }),
    };
    const run = begin(captured, ["survivor", "canceled.installing"], { survivor: survivor() });
    await run.pending;
    expect(run.harness.dialogCalls).toEqual([]);
    expect(run.add).not.toHaveBeenCalled();
  });

  it("revalidate changes while the prompt is open: does not overwrite a newly registered install", async () => {
    const run = begin({ survivor: survivor() }, ["survivor", "unknownmod"]);
    const choice = Promise.withResolvers<{ action: string; input: Record<string, never> }>();
    const dialog = vi
      .spyOn(run.harness.api, "showDialog")
      .mockReturnValue(Bluebird.resolve(choice.promise));
    await vi.waitFor(() => expect(dialog).toHaveBeenCalledOnce());
    run.harness.api.store.dispatch(
      addMod(GAME, makeMod({ id: "unknownmod", state: "installing" })),
    );
    choice.resolve({ action: "Apply Changes", input: {} });
    await run.pending;
    expect(run.add).not.toHaveBeenCalled();
    expect(run.harness.getState().persistent.mods[GAME].unknownmod.state).toBe("installing");
  });

  it("revalidate changes while the prompt is open: does not remove a replacement settled record", async () => {
    const run = begin(
      { survivor: survivor(), removed: makeMod({ id: "removed", state: "installed" }) },
      ["survivor"],
    );
    const choice = Promise.withResolvers<{ action: string; input: Record<string, never> }>();
    const dialog = vi
      .spyOn(run.harness.api, "showDialog")
      .mockReturnValue(Bluebird.resolve(choice.promise));
    await vi.waitFor(() => expect(dialog).toHaveBeenCalledOnce());
    run.harness.api.store.dispatch(
      addMod(
        GAME,
        makeMod({ id: "removed", state: "installed", attributes: { name: "Replacement record" } }),
      ),
    );
    choice.resolve({ action: "Apply Changes", input: {} });
    await run.pending;
    expect(run.remove).toHaveBeenCalledWith([]);
    expect(run.harness.getState().persistent.mods[GAME].removed.attributes.name).toBe(
      "Replacement record",
    );
  });

  it("does not remove a settled record replaced while the directory scan is pending", async () => {
    const run = begin(
      { survivor: survivor(), changed: makeMod({ id: "changed", state: "installed" }) },
      ["survivor"],
    );
    run.harness.api.store.dispatch(
      addMod(
        GAME,
        makeMod({ id: "changed", state: "installed", attributes: { name: "New generation" } }),
      ),
    );
    await run.pending;
    expect(run.harness.dialogCalls).toEqual([]);
    expect(run.remove).not.toHaveBeenCalled();
  });

  it.each(["Delete", "Ignore"])("preserves unknown incomplete recovery: %s", async (action) => {
    const run = begin({ survivor: survivor() }, ["survivor", "interrupted.installing"]);
    const dialog = vi
      .spyOn(run.harness.api, "showDialog")
      .mockImplementation((type) =>
        Bluebird.resolve({ action: type === "question" ? "Apply Changes" : action, input: {} }),
      );
    await run.pending;
    expect(dialog).toHaveBeenCalledTimes(2);
    expect(dialog).toHaveBeenNthCalledWith(2, "error", "interrupted", expect.anything(), [
      { label: "Ignore" },
      { label: "Delete" },
    ]);
    expect(removedPaths).toEqual(
      action === "Delete" ? [path.join(STAGING, "interrupted.installing")] : [],
    );
    expect(run.add).not.toHaveBeenCalled();
  });

  it("does not offer nested incomplete recovery for an install registered during its stat", async () => {
    const entered = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    let matchingStats = 0;
    afterStat = async (full) => {
      if (full === path.join(STAGING, "lateinstall.installing") && ++matchingStats === 2) {
        entered.resolve();
        await released.promise;
      }
    };
    const run = begin({ survivor: survivor() }, ["survivor", "lateinstall.installing"]);
    await entered.promise;
    run.harness.api.store.dispatch(
      addMod(GAME, makeMod({ id: "lateinstall", state: "installing" })),
    );
    released.resolve();
    await run.pending;
    expect(run.harness.dialogCalls).toEqual([{ type: "question", title: "Mods changed on disk" }]);
    expect(removedPaths).toEqual([]);
  });

  it("does not delete an active install after a nested incomplete recovery prompt", async () => {
    const choice = Promise.withResolvers<{ action: string; input: Record<string, never> }>();
    const run = begin({ survivor: survivor() }, ["survivor", "recovery-race.installing"]);
    const dialog = vi
      .spyOn(run.harness.api, "showDialog")
      .mockImplementation((type) =>
        type === "question"
          ? Bluebird.resolve({ action: "Apply Changes", input: {} })
          : Bluebird.resolve(choice.promise),
      );
    await vi.waitFor(() => expect(dialog).toHaveBeenCalledTimes(2));
    run.harness.api.store.dispatch(
      addMod(GAME, makeMod({ id: "recovery-race", state: "installing" })),
    );
    choice.resolve({ action: "Delete", input: {} });
    await run.pending;
    expect(removedPaths).toEqual([]);
    expect(run.harness.getState().persistent.mods[GAME]["recovery-race"].state).toBe("installing");
  });

  it("still reports and reconciles a genuine settled external deletion", async () => {
    const run = begin(
      { survivor: survivor(), removed: makeMod({ id: "removed", state: "installed" }) },
      ["survivor"],
    );
    await run.pending;
    expect(run.harness.dialogCalls).toEqual([{ type: "question", title: "Mods changed on disk" }]);
    expect(run.remove).toHaveBeenCalledWith(["removed"]);
  });

  it("still reports a genuinely unknown external directory", async () => {
    const run = begin({ survivor: survivor() }, ["survivor", "unknownmod"]);
    await run.pending;
    expect(run.harness.dialogCalls).toEqual([{ type: "question", title: "Mods changed on disk" }]);
    expect(run.add).toHaveBeenCalledWith(
      expect.objectContaining({ id: "unknownmod", state: "installed" }),
    );
  });
});
