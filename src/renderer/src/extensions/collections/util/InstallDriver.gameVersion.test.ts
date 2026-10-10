import type { ICollection } from "@nexusmods/nexus-api";
import { describe, expect, vi } from "vitest";

import { makeCollectionModInfo, makeDownload, makeRevision } from "../../../test-utils/builders";
import { test } from "../../../test-utils/collectionTest";
import type { ICollectionHarness } from "../../../test-utils/harnessTypes";
import type { IDialogResult } from "../../../types/IDialog";
import { getGame } from "../../gamemode_management/util/getGame";
import type { IProfile } from "../../profile_management/types/IProfile";
import { skipWhileSuppressed, withSuppressedTests } from "../../test_runner/suppressedTests";
import type { IRevisionEx } from "../types/IRevisionEx";
import { makeDriverUpdateHandler } from "./InstallDriver";

const GAME = "skyrimse";
const COLLECTION = "col-1";
const ARCHIVE = `dl-${COLLECTION}`;
const PREVIOUS = "col-0";

/** The collection download, carrying revision info that asks for a game version not installed. */
function mismatchedGameVersion() {
  const modInfo = makeCollectionModInfo({ collectionId: 1, revisionId: 2, gameId: GAME });
  // Cached revision; the harness game reports 1.0.0.
  modInfo.nexus.revisionInfo = { modFiles: [], gameVersions: [{ reference: "9.9.9" }] };
  return { downloads: { [ARCHIVE]: makeDownload({ id: ARCHIVE, state: "finished", modInfo }) } };
}

// Use the extension's actual auto-continue handler, not only a standalone driver.
function withExtensionHandler(h: ICollectionHarness) {
  const begun: string[][] = [];
  h.api.events.on("install-dependencies", (_profileId: string, _gameId: string, ids: string[]) =>
    begun.push(ids),
  );
  let updates = 0;
  h.driver.onUpdate(() => {
    updates += 1;
  });
  h.driver.onUpdate(makeDriverUpdateHandler(h.api, h.driver));
  return { begun, updates: () => updates };
}

async function openInstallDialog(h: ICollectionHarness) {
  const revision = makeRevision(1, [{ tag: "a" }], { collectionId: COLLECTION });
  h.setState((draft) => {
    (draft.persistent.mods[GAME] ??= {})[COLLECTION] = revision.collection;
  });
  const profile: IProfile = h.getState().persistent.profiles["prof-1"];
  await h.driver.query(profile, revision.collection);
  expect(h.driver.step).toBe("query");
  return revision;
}

/** Let the driver's async continue() calls, started from onUpdate, run to completion. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function completeAnotherInstall(h: ICollectionHarness) {
  await h.installRevision(makeRevision(1, [{ tag: "a" }], { collectionId: PREVIOUS }));
  await settle();
  await h.completeActiveInstall();
  expect(h.driver.step).toBe("review");
  expect(h.driver.collection).toBeUndefined();
}

const installCompleted = (h: ICollectionHarness) =>
  h.getState().persistent.mods[GAME][COLLECTION]?.attributes?.installCompleted;

const reviewShown = (h: ICollectionHarness) =>
  h.driver.collection !== undefined && h.driver.step === "review";

function deferDialogs(h: ICollectionHarness) {
  const answers: Array<(result: IDialogResult) => void> = [];
  const showDialog = vi.fn(() => new Promise<IDialogResult>((resolve) => answers.push(resolve)));
  Object.assign(h.api, { showDialog });
  return { answers, showDialog };
}

describe("InstallDriver game-version prompt", () => {
  for (const fromDialog of [true, false]) {
    test(`Cancel from ${fromDialog ? "Install Now" : "resume"} ends the attempt`, async ({
      makeCollection,
    }) => {
      const h = makeCollection(mismatchedGameVersion());
      const { begun, updates } = withExtensionHandler(h);
      if (fromDialog) await openInstallDialog(h);
      h.setNextDialog({ action: "Cancel", input: {} });

      if (fromDialog) await h.driver.continue();
      else await h.installRevision(makeRevision(1, [{ tag: "a" }], { collectionId: COLLECTION }));
      await settle();

      expect(h.dialogCalls.map((call) => call.title)).toEqual(["Game version mismatch"]);
      expect(h.driver.step).toBe("prepare");
      expect(h.driver.collection).toBeUndefined();
      const updatesAtCancel = updates();
      expect(updatesAtCancel).toBeGreaterThan(0);

      h.emit("did-install-mod", GAME, "other-archive", "other-mod");
      await h.driver.continue();
      await settle();

      expect(updates()).toBeGreaterThan(updatesAtCancel);
      expect(begun).toEqual([]);
      expect(h.getState().session.collections.activeSession).toBeUndefined();
    });
  }

  test("Continue installs the collection", async ({ makeCollection }) => {
    const h = makeCollection(mismatchedGameVersion());
    const { begun } = withExtensionHandler(h);
    await openInstallDialog(h);
    h.setNextDialog({ action: "Continue", input: {} });

    await h.driver.continue();
    await settle();

    expect(h.dialogCalls.map((call) => call.title)).toEqual(["Game version mismatch"]);
    expect(begun).toEqual([[COLLECTION]]);
    expect(h.driver.step).toBe("installing");
    expect(h.getState().session.collections.activeSession?.collectionId).toBe(COLLECTION);
  });

  test("an update while the prompt is open does not begin the install", async ({
    makeCollection,
  }) => {
    const h = makeCollection(mismatchedGameVersion());
    const { begun } = withExtensionHandler(h);
    await openInstallDialog(h);
    const { answers, showDialog } = deferDialogs(h);

    const installNow = h.driver.continue();
    await vi.waitFor(() => expect(showDialog).toHaveBeenCalled());
    h.emit("did-install-mod", GAME, "other-archive", "other-mod");
    await settle();

    expect(begun).toEqual([]);

    answers[0]({ action: "Continue", input: {} });
    await installNow;
    await settle();

    expect(begun).toEqual([[COLLECTION]]);
  });

  test("Continue after a pause while the prompt was open does not start the install", async ({
    makeCollection,
  }) => {
    const h = makeCollection(mismatchedGameVersion());
    const { begun } = withExtensionHandler(h);
    await openInstallDialog(h);
    const { answers, showDialog } = deferDialogs(h);

    const installNow = h.driver.continue();
    await vi.waitFor(() => expect(showDialog).toHaveBeenCalled());
    // logout and game switch pause the install through pauseCollection
    h.driver.pause("logout");
    answers[0]({ action: "Continue", input: {} });
    await installNow;
    await settle();

    expect(begun).toEqual([]);
    expect(h.driver.step).toBe("prepare");
    expect(h.getState().session.collections.activeSession).toBeUndefined();
  });

  for (const action of ["Cancel", "Continue"]) {
    for (const sameObject of [true, false]) {
      test(`stale ${action} leaves a resumed ${sameObject ? "same" : "replacement"} collection and its hold alone`, async ({
        makeCollection,
      }) => {
        const h = makeCollection(mismatchedGameVersion());
        const { begun } = withExtensionHandler(h);
        Object.assign(h.api.ext, { withSuppressedTests });
        const revision = await openInstallDialog(h);
        const profile = h.driver.profile;
        const collection = sameObject ? revision.collection : { ...revision.collection };
        const { answers, showDialog } = deferDialogs(h);

        const installNow = h.driver.continue();
        await vi.waitFor(() => expect(showDialog).toHaveBeenCalledTimes(1));
        h.driver.pause("logout");
        // Real resume-collection passes the mod directly; do not rebuild it through installRevision.
        const resume = h.driver.start(profile, collection);
        await vi.waitFor(() => expect(showDialog).toHaveBeenCalledTimes(2));
        try {
          answers[0]({ action, input: {} });
          await installNow;
          h.emit("did-install-mod", GAME, "other-archive", "other-mod");
          await settle();

          expect(begun).toEqual([]);
          expect(h.driver.collection).toBe(collection);
          expect(h.driver.step).toBe("start");
          expect(skipWhileSuppressed("plugins-changed", () => undefined)).toBe(true);
          expect(h.getState().session.collections.activeSession).toBeUndefined();

          answers[1]({ action: "Continue", input: {} });
          await resume;
          await settle();

          expect(begun).toEqual([[COLLECTION]]);
          expect(skipWhileSuppressed("plugins-changed", () => undefined)).toBe(true);
        } finally {
          answers.forEach((answer) => answer({ action: "Cancel", input: {} }));
          await Promise.all([installNow, resume]);
          h.driver.cancel();
          await settle();
        }
        expect(skipWhileSuppressed("plugins-changed", () => undefined)).toBe(false);
      });
    }
  }

  for (const delayed of ["revision", "version"] as const) {
    test(`a paused ${delayed} lookup cannot overwrite or prompt the resumed attempt`, async ({
      makeCollection,
    }) => {
      const seed = mismatchedGameVersion();
      if (delayed === "revision") {
        delete seed.downloads[ARCHIVE].modInfo.nexus.revisionInfo;
      }
      const h = makeCollection(seed);
      const { begun } = withExtensionHandler(h);
      Object.assign(h.api.ext, { withSuppressedTests });
      const revision = await openInstallDialog(h);
      const profile = h.driver.profile;
      let deliver: () => void = () => undefined;
      const fetch =
        delayed === "revision"
          ? vi
              .spyOn(h.driver.infoCache, "getRevisionInfo")
              .mockImplementationOnce(
                () =>
                  new Promise<IRevisionEx>((resolve) => {
                    deliver = () =>
                      resolve({
                        modFiles: [],
                        gameVersions: [{ reference: "9.9.9" }],
                      } as IRevisionEx);
                  }),
              )
              .mockResolvedValue({ modFiles: [], gameVersions: [] } as IRevisionEx)
          : vi
              .spyOn(getGame(GAME), "getGameVersion")
              .mockImplementationOnce(
                () =>
                  new Promise<string>((resolve) => {
                    deliver = () => resolve("0.1.0");
                  }),
              )
              .mockResolvedValue("9.9.9");
      const first = h.driver.continue();
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
      h.driver.pause("logout");
      try {
        await h.driver.start(profile, revision.collection);
        await settle();
        const currentRevision = h.driver.revisionInfo;
        const session = h.driver.currentSessionId;
        const actions = h.dispatched.length;
        deliver();
        await first;
        await settle();
        expect(h.dialogCalls).toEqual([]);
        expect(h.driver.revisionInfo).toBe(currentRevision);
        expect(h.driver.currentSessionId).toBe(session);
        expect(h.dispatched).toHaveLength(actions);
        expect(begun).toEqual([[COLLECTION]]);
        expect(h.driver.step).toBe("installing");
        expect(skipWhileSuppressed("plugins-changed", () => undefined)).toBe(true);
      } finally {
        deliver();
        await first;
        h.driver.cancel();
        await settle();
      }
      expect(skipWhileSuppressed("plugins-changed", () => undefined)).toBe(false);
    });
  }

  test("late collection metadata cannot overwrite or continue a resumed attempt", async ({
    makeCollection,
  }) => {
    const seed = mismatchedGameVersion();
    seed.downloads[ARCHIVE].modInfo.nexus.ids.collectionSlug = "metadata";
    const h = makeCollection(seed);
    const { begun } = withExtensionHandler(h);
    Object.assign(h.api.ext, { withSuppressedTests });
    const fresh = { name: "current" } as ICollection;
    const fetch = vi.spyOn(h.driver.infoCache, "getCollectionInfo").mockResolvedValue(fresh);
    const revision = await openInstallDialog(h);
    const profile = h.driver.profile;
    let deliver: () => void = () => undefined;
    fetch.mockImplementationOnce(
      () =>
        new Promise<ICollection>((resolve) => {
          deliver = () => resolve({ name: "old" } as ICollection);
        }),
    );
    const first = h.driver.continue();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    h.driver.pause("logout");
    h.setNextDialog({ action: "Continue", input: {} });
    try {
      await h.driver.start(profile, revision.collection);
      await settle();
      const session = h.driver.currentSessionId;
      deliver();
      await first;
      await settle();
      expect(h.driver.collectionInfo).toBe(fresh);
      expect(h.driver.currentSessionId).toBe(session);
      expect(begun).toEqual([[COLLECTION]]);
      expect(h.driver.step).toBe("installing");
      expect(skipWhileSuppressed("plugins-changed", () => undefined)).toBe(true);
    } finally {
      deliver();
      await first;
      h.driver.cancel();
      await settle();
    }
  });

  test("failed startup metadata leaves the driver idle and checks released", async ({
    makeCollection,
  }) => {
    const seed = mismatchedGameVersion();
    seed.downloads[ARCHIVE].modInfo.nexus.ids.collectionSlug = "metadata";
    const h = makeCollection(seed);
    const { begun } = withExtensionHandler(h);
    Object.assign(h.api.ext, { withSuppressedTests });
    const failure = new Error("metadata unavailable");
    vi.spyOn(h.driver.infoCache, "getCollectionInfo")
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(undefined);
    h.setNextDialog({ action: "Continue", input: {} });
    try {
      await expect(
        h.installRevision(makeRevision(1, [{ tag: "a" }], { collectionId: COLLECTION })),
      ).rejects.toBe(failure);
      h.emit("did-install-mod", GAME, "other-archive", "other-mod");
      await settle();
      expect(h.driver.collection).toBeUndefined();
      expect(h.driver.step).toBe("prepare");
      expect(begun).toEqual([]);
      expect(h.getState().session.collections.activeSession).toBeUndefined();
      expect(skipWhileSuppressed("plugins-changed", () => undefined)).toBe(false);
    } finally {
      h.driver.cancel();
      await settle();
    }
  });

  for (const recommendations of [false, true]) {
    test(`late ${recommendations ? "optional" : "required"} completion metadata leaves a resumed prompt alone`, async ({
      makeCollection,
    }) => {
      const seed = mismatchedGameVersion();
      seed.downloads[ARCHIVE].modInfo.nexus.ids.collectionSlug = "metadata";
      const h = makeCollection(seed);
      const { begun } = withExtensionHandler(h);
      Object.assign(h.api.ext, { withSuppressedTests });
      h.setNextDialog({ action: "Continue", input: {} });
      const fetch = vi.spyOn(h.driver.infoCache, "getCollectionInfo").mockResolvedValue(undefined);
      const revision = makeRevision(1, [{ tag: "a" }], { collectionId: COLLECTION });
      await h.installRevision(revision);
      await settle();
      h.setState((draft) => {
        for (const member of Object.values(draft.session.collections.activeSession.mods))
          member.status = "installed";
      });
      const profile = h.driver.profile;
      let deliver: () => void = () => undefined;
      fetch.mockClear().mockImplementationOnce(
        () =>
          new Promise<ICollection>((resolve) => {
            deliver = () => resolve(undefined);
          }),
      );
      h.emit("did-install-dependencies", GAME, COLLECTION, recommendations);
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
      h.driver.pause("logout");
      const { answers, showDialog } = deferDialogs(h);
      const resume = h.driver.start(profile, revision.collection);
      await vi.waitFor(() => expect(showDialog).toHaveBeenCalledTimes(1));
      try {
        deliver();
        await settle();
        expect(h.driver.step).toBe("start");
        expect(installCompleted(h)).toBeUndefined();
        expect(begun).toEqual([[COLLECTION]]);
        expect(skipWhileSuppressed("plugins-changed", () => undefined)).toBe(true);
      } finally {
        deliver();
        answers[0]({ action: "Cancel", input: {} });
        await resume;
        h.driver.cancel();
        await settle();
      }
    });
  }

  test("a resume right after a finished install does not review it while the prompt is open", async ({
    makeCollection,
  }) => {
    const h = makeCollection(mismatchedGameVersion());
    const { begun } = withExtensionHandler(h);
    await completeAnotherInstall(h);
    const { answers, showDialog } = deferDialogs(h);

    const resume = h.installRevision(makeRevision(1, [{ tag: "b" }], { collectionId: COLLECTION }));
    await vi.waitFor(() => expect(showDialog).toHaveBeenCalled());
    h.emit("did-install-mod", GAME, "other-archive", "other-mod");
    await settle();

    expect(reviewShown(h)).toBe(false);
    expect(installCompleted(h)).toBeUndefined();
    expect(begun).toEqual([[PREVIOUS]]);
    expect(h.driver.step).toBe("start");

    answers[0]({ action: "Cancel", input: {} });
    await resume;
    await settle();

    expect(h.driver.step).toBe("prepare");
    expect(reviewShown(h)).toBe(false);
    expect(installCompleted(h)).toBeUndefined();
    expect(begun).toEqual([[PREVIOUS]]);
  });

  test("a resume right after a finished install waits for its revision info", async ({
    makeCollection,
  }) => {
    const modInfo = makeCollectionModInfo({ collectionId: 1, revisionId: 2, gameId: GAME });
    const h = makeCollection({
      downloads: { [ARCHIVE]: makeDownload({ id: ARCHIVE, state: "finished", modInfo }) },
    });
    const { begun } = withExtensionHandler(h);
    await completeAnotherInstall(h);
    let deliver: (revision: IRevisionEx) => void = () => undefined;
    const fetch = vi
      .spyOn(h.driver.infoCache, "getRevisionInfo")
      .mockImplementation(() => new Promise<IRevisionEx>((resolve) => (deliver = resolve)));

    const resume = h.installRevision(makeRevision(1, [{ tag: "b" }], { collectionId: COLLECTION }));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    h.emit("did-install-mod", GAME, "other-archive", "other-mod");
    await settle();

    expect(reviewShown(h)).toBe(false);
    expect(installCompleted(h)).toBeUndefined();
    expect(begun).toEqual([[PREVIOUS]]);
    expect(h.driver.step).toBe("start");

    // a revision the installed game matches: no prompt, so the install begins
    deliver({ modFiles: [], gameVersions: [] } as unknown as IRevisionEx);
    await resume;
    await settle();

    expect(h.dialogCalls).toEqual([]);
    expect(begun).toEqual([[PREVIOUS], [COLLECTION]]);
    expect(h.driver.step).toBe("installing");
  });
});
