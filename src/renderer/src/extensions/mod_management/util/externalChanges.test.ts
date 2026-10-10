import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  IDeployedFile,
  IDeploymentMethod,
  IExtensionApi,
  IFileChange,
} from "../../../types/IExtensionContext";
import type { IState } from "../../../types/IState";
import * as fs from "../../../util/fs";
import { MERGED_PATH } from "../modMerging";
import type { IFileEntry } from "../types/IFileEntry";

// Mock fs. applyFileActions inside dealWithExternalChanges calls into it
// whenever any auto-resolved changes are present. Real fs ops would fail in a
// unit test, so make every call a no-op.
vi.mock("../../../util/fs", () => ({
  removeAsync: vi.fn(() => Promise.resolve()),
  moveAsync: vi.fn(() => Promise.resolve()),
  statAsync: vi.fn(() => Promise.resolve({ mtime: new Date(0) })),
  lstatAsync: vi.fn(() => Promise.resolve({ mtime: new Date(0) })),
}));

vi.mock("../../../logging", () => {
  const log = vi.fn();
  return { default: log, log };
});

// Required mocks for the real InstallManager imported below. The integration
// test at the bottom builds a real InstallManager so it can drive the
// markRecentInstall / markRecentRemoval / consumeRecentChanges flow against
// the live implementation (rather than re-stating the resulting Set inline).
vi.mock("../util/dependencies");
vi.mock("../../../util/api");
vi.mock("../../../util/getVortexPath", () => ({ default: vi.fn(() => "/tmp") }));

// Capture every payload passed to showExternalChanges so each test can assert
// what would have been surfaced to the user.
const showExternalChangesCalls: Array<{ [typeId: string]: IFileChange[] }> = [];
let chosenActions: IFileEntry[] = [];
// externalChanges.ts only imports `showExternalChanges` from this module, so
// stubbing that one export is sufficient. The returned thunk resolves with
// chosenActions models the user response; empty by default. The target-path
// cases below explicitly select a file action and exercise applyFileActions.
vi.mock("../actions/session", () => ({
  showExternalChanges: vi.fn((changes: { [typeId: string]: IFileChange[] }) => {
    return () => {
      showExternalChangesCalls.push(changes);
      return Promise.resolve(chosenActions);
    };
  }),
}));

import InstallManager from "../InstallManager";
import { changeToEntry, dealWithExternalChanges } from "./externalChanges";

function makeRefchange(source: string, filePath: string): IFileChange {
  return {
    filePath,
    source,
    sourceTime: new Date(0),
    destTime: new Date(0),
    changeType: "refchange",
  };
}

function makeApi(opts: { externalChanges: IFileChange[]; activeSession?: unknown }): {
  api: IExtensionApi;
  activator: IDeploymentMethod;
} {
  const state = {
    persistent: {
      profiles: {
        "test-profile": {
          id: "test-profile",
          gameId: "skyrimse",
        },
      },
    },
    session: {
      collections: { activeSession: opts.activeSession ?? undefined },
    },
    settings: {
      profiles: { activeProfileId: "test-profile" },
    },
  } as unknown as IState;

  const api: IExtensionApi = {
    store: {
      getState: () => state,
      dispatch: vi.fn((action: unknown) => {
        // Honour thunks (functions). That's how showExternalChanges resolves.
        if (typeof action === "function") {
          return (action as (d: unknown) => unknown)(vi.fn());
        }
        return action;
      }),
    },
    events: {
      emit: vi.fn(),
    },
  } as unknown as IExtensionApi;

  const activator: IDeploymentMethod = {
    externalChanges: vi.fn(() => Promise.resolve(opts.externalChanges)),
  } as unknown as IDeploymentMethod;

  return { api, activator };
}

const FAKE_STAGING = "C:\\staging";
const FAKE_MOD_PATHS = { "": "C:\\game\\Data" };
// dealWithExternalChanges iterates over lastDeployment keys (modTypes) to
// dispatch applyFileActions; the per-entry contents don't matter once changes
// are produced by the (mocked) activator.
const FAKE_LAST_DEPLOYMENT: { [typeId: string]: IDeployedFile[] } = { "": [] };

describe("dealWithExternalChanges", () => {
  beforeEach(() => {
    showExternalChangesCalls.length = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("auto-resolves __merged changes regardless of recentChanges", async () => {
    const { api, activator } = makeApi({
      externalChanges: [makeRefchange(`${MERGED_PATH}_skyrim`, "Data/merged.esp")],
    });

    await dealWithExternalChanges(
      api,
      activator,
      "test-profile",
      FAKE_STAGING,
      FAKE_MOD_PATHS,
      FAKE_LAST_DEPLOYMENT,
      new Set(),
    );

    expect(showExternalChangesCalls).toHaveLength(0);
  });

  it("auto-resolves every change during a collection install", async () => {
    const { api, activator } = makeApi({
      externalChanges: [
        makeRefchange("some-mod-A", "Data/a.bsa"),
        makeRefchange("some-mod-B", "Data/b.bsa"),
      ],
      activeSession: { collectionSlug: "fake-collection", state: "installing" },
    });

    await dealWithExternalChanges(
      api,
      activator,
      "test-profile",
      FAKE_STAGING,
      FAKE_MOD_PATHS,
      FAKE_LAST_DEPLOYMENT,
      new Set(),
    );

    expect(showExternalChangesCalls).toHaveLength(0);
  });

  it("treats an undefined recentChanges as 'nothing recently touched'", async () => {
    const { api, activator } = makeApi({
      externalChanges: [makeRefchange("any-mod", "Data/file.esp")],
    });

    await dealWithExternalChanges(
      api,
      activator,
      "test-profile",
      FAKE_STAGING,
      FAKE_MOD_PATHS,
      FAKE_LAST_DEPLOYMENT,
      undefined,
    );

    expect(showExternalChangesCalls).toHaveLength(1);
    expect(showExternalChangesCalls[0][""]?.[0].source).toBe("any-mod");
  });

  // A deployment cycle consumes the recentChanges snapshot ONCE at the start,
  // then runs dealWithExternalChanges against that snapshot. If a second
  // install completes after the snapshot is taken (e.g. parallel installers,
  // or an install that finished while the first deployment was still in
  // flight), its installation path is not in the local recentChanges seen
  // by the current dealWithExternalChanges call. A refchange attributed to
  // that just-installed mod therefore surfaces to the user, even though
  // Vortex did install it. This is correct behavior given the input; the
  // upstream concern is whether two install/deploy flows should overlap at
  // all. Locks in the snapshot-at-consume-time contract between
  // InstallManager and dealWithExternalChanges.
  it("only auto-resolves against the recentChanges snapshot taken at consume time", async () => {
    const gameId = "skyrimse";
    const modA = "mod-A-installed-before-consume";
    const modB = "mod-B-installed-after-consume";

    const state = {
      persistent: {
        mods: {
          [gameId]: {
            [modA]: { id: modA, installationPath: modA },
            [modB]: { id: modB, installationPath: modB },
          },
        },
      },
    };
    const installManagerApi = {
      getState: vi.fn(() => state),
      store: { dispatch: vi.fn(), getState: vi.fn(() => state) },
      events: { emit: vi.fn(), on: vi.fn(), once: vi.fn(), removeListener: vi.fn() },
      onAsync: vi.fn(),
      onStateChange: vi.fn(),
      sendNotification: vi.fn(),
      dismissNotification: vi.fn(),
      showErrorNotification: vi.fn(),
      translate: vi.fn((key: string) => key),
      registerInstaller: vi.fn(),
    } as unknown as IExtensionApi;
    const installManager = new InstallManager(installManagerApi, vi.fn());

    // Install A completes BEFORE the deployment cycle starts.
    installManager.markRecentInstall(modA, gameId);

    // Deployment cycle begins: snapshot recentChanges.
    const snapshot = installManager.consumeRecentChanges();
    expect(snapshot).toEqual(new Set([modA]));

    // Install B completes WHILE the deployment cycle is in flight, after
    // the snapshot has been taken. Its path goes into the next batch.
    installManager.markRecentInstall(modB, gameId);

    // The current deployment cycle calls dealWithExternalChanges with the
    // snapshot. The activator reports a refchange attributed to mod B
    // (a stale manifest entry, an in-flight unlink/relink, etc.).
    const { api, activator } = makeApi({
      externalChanges: [makeRefchange(modA, "Data/a.esp"), makeRefchange(modB, "Data/b.esp")],
    });

    await dealWithExternalChanges(
      api,
      activator,
      "test-profile",
      FAKE_STAGING,
      FAKE_MOD_PATHS,
      FAKE_LAST_DEPLOYMENT,
      snapshot,
    );

    // A is auto-resolved (in snapshot), B surfaces (not in snapshot).
    expect(showExternalChangesCalls).toHaveLength(1);
    const surfaced = showExternalChangesCalls[0][""];
    expect(surfaced).toHaveLength(1);
    expect(surfaced?.[0].source).toBe(modB);

    // The next deployment cycle would pick up B.
    expect(installManager.consumeRecentChanges()).toEqual(new Set([modB]));
  });
});

describe("external change deployment identity", () => {
  beforeEach(() => {
    chosenActions = [];
    showExternalChangesCalls.length = 0;
  });
  afterEach(() => {
    chosenActions = [];
    vi.clearAllMocks();
  });
  const changeFor = (source: string, changeType: "srcdeleted" | "deleted"): IFileChange => ({
    source,
    filePath: "config.ini",
    changeType,
    sourceTime: new Date(0),
    destTime: new Date(0),
  });
  const manifestFor = (source: string, target: string): IDeployedFile => ({
    source,
    target,
    relPath: "config.ini",
    time: 0,
  });
  const run = (changes: IFileChange[], entries: IDeployedFile[], recentChanges?: Set<string>) => {
    const { api, activator } = makeApi({ externalChanges: changes });
    return dealWithExternalChanges(
      api,
      activator,
      "test-profile",
      FAKE_STAGING,
      FAKE_MOD_PATHS,
      { "": entries },
      recentChanges,
    );
  };

  it.each(["", "mod-subfolder"])("applies explicit drop to target '%s'", async (target) => {
    const change = changeFor("mod-A", "srcdeleted");
    chosenActions = [changeToEntry("", change)];
    const result = await run([change], [manifestFor(change.source, target)]);
    expect(showExternalChangesCalls).toEqual([{ "": [change] }]);
    expect(fs.removeAsync).toHaveBeenCalledExactlyOnceWith(
      path.join(FAKE_MOD_PATHS[""], target, change.filePath),
    );
    expect(fs.moveAsync).not.toHaveBeenCalled();
    expect(result).toEqual([[]]);
  });

  it("imports the chosen target and retains another mod's same-named manifest entry", async () => {
    const change = changeFor("mod-A", "srcdeleted");
    const keeper = manifestFor("mod-B", "target-B");
    chosenActions = [{ ...changeToEntry("", change), action: "import" }];
    const result = await run([change], [manifestFor(change.source, "target-A"), keeper]);
    expect(fs.removeAsync).toHaveBeenCalledExactlyOnceWith(
      path.join(FAKE_STAGING, "mod-A", "config.ini"),
    );
    expect(fs.moveAsync).toHaveBeenCalledExactlyOnceWith(
      path.join(FAKE_MOD_PATHS[""], "target-A", "config.ini"),
      path.join(FAKE_STAGING, "mod-A", "config.ini"),
      { overwrite: true },
    );
    expect(result).toEqual([[keeper]]);
  });

  it.each([false, true])(
    "drops only the owning manifest entry (automatic=%s)",
    async (automatic) => {
      const change = changeFor("mod-A", "srcdeleted");
      const keeper = manifestFor("mod-B", "target-B");
      if (!automatic) chosenActions = [changeToEntry("", change)];
      const result = await run(
        [change],
        [manifestFor(change.source, "target-A"), keeper],
        automatic ? new Set(["mod-A"]) : undefined,
      );
      expect(showExternalChangesCalls).toHaveLength(automatic ? 0 : 1);
      expect(fs.removeAsync).toHaveBeenCalledExactlyOnceWith(
        path.join(FAKE_MOD_PATHS[""], "target-A", "config.ini"),
      );
      expect(result).toEqual([[keeper]]);
    },
  );

  it.each(["restore", "delete"] as const)(
    "keeps another source's manifest entry on %s",
    async (action) => {
      const change = changeFor("mod-A", "deleted");
      const keeper = manifestFor("mod-B", "target-B");
      chosenActions = [{ ...changeToEntry("", change), action }];
      const result = await run([change], [manifestFor(change.source, "target-A"), keeper]);
      expect(result).toEqual([[keeper]]);
      expect(fs.moveAsync).not.toHaveBeenCalled();
      if (action === "delete") {
        expect(fs.removeAsync).toHaveBeenCalledExactlyOnceWith(
          path.join(FAKE_STAGING, "mod-A", "config.ini"),
        );
      } else {
        expect(fs.removeAsync).not.toHaveBeenCalled();
      }
    },
  );

  it("asks before deleting an uninstalled mod's replacement with a preserved timestamp", async () => {
    vi.mocked(fs.lstatAsync).mockResolvedValueOnce({
      mtime: new Date(0),
      isFile: () => true,
    } as never);
    const change = changeFor("removed-mod", "srcdeleted");
    const manifest = manifestFor(change.source, "removed-mod-target");
    const result = await run([change], [manifest]);
    expect(showExternalChangesCalls).toEqual([{ "": [change] }]);
    expect(fs.removeAsync).not.toHaveBeenCalled();
    expect(fs.moveAsync).not.toHaveBeenCalled();
    expect(result).toEqual([[manifest]]);
  });
});
