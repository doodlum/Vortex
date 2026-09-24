/**
 * When a collection revision lists game versions and none matches the installed game, the driver
 * asks whether to go on ("Game version mismatch", Cancel / Continue). These tests drive the REAL
 * driver through the collection harness, with the collections extension's own onUpdate handler
 * (makeDriverUpdateHandler), which continues the driver whenever it sits on the "start" step and
 * stamps installCompleted when it sits on "review".
 *
 * The regressions they pin: Cancel left the driver on "start" with the collection still set, so
 * the next driver update, or a second "Install Now", began the install anyway; and a start right
 * after a finished install must not leave that install's "review" showing for the new collection.
 */
import { describe, expect, vi } from "vitest";

import { makeCollectionModInfo, makeDownload, makeRevision } from "../../../test-utils/builders";
import { test } from "../../../test-utils/collectionTest";
import type { ICollectionHarness } from "../../../test-utils/harnessTypes";
import type { IDialogResult } from "../../../types/IDialog";
import type { IProfile } from "../../profile_management/types/IProfile";
import type { IRevisionEx } from "../types/IRevisionEx";
import { makeDriverUpdateHandler } from "./InstallDriver";

const GAME = "skyrimse";
const COLLECTION = "col-1";
const ARCHIVE = `dl-${COLLECTION}`;
// a collection installed and reviewed before the one under test
const PREVIOUS = "col-0";

/** The collection download, carrying revision info that asks for a game version not installed. */
function mismatchedGameVersion() {
  const modInfo = makeCollectionModInfo({ collectionId: 1, revisionId: 2, gameId: GAME });
  // revision info on the download, so the driver reads it without a network fetch; the
  // harness game reports 1.0.0
  modInfo.nexus.revisionInfo = { modFiles: [], gameVersions: [{ reference: "9.9.9" }] };
  return { downloads: { [ARCHIVE]: makeDownload({ id: ARCHIVE, state: "finished", modInfo }) } };
}

/**
 * Wire up what the collections extension adds around the driver: its own onUpdate handler, which
 * continues from "start" and stamps installCompleted at "review", and a count of the
 * install-dependencies events that actually begin an install.
 */
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

/** Put the collection in state and open the install dialog, as a freshly added collection does. */
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

/**
 * Install another collection to its review and press Done there. That leaves the driver on
 * "review" with no collection, as it stays until something else starts.
 */
async function completeAnotherInstall(h: ICollectionHarness) {
  await h.installRevision(makeRevision(1, [{ tag: "a" }], { collectionId: PREVIOUS }));
  await settle();
  await h.completeActiveInstall();
  expect(h.driver.step).toBe("review");
  expect(h.driver.collection).toBeUndefined();
}

/** When the collection's review last opened, as the extension's update handler stamps it. */
const installCompleted = (h: ICollectionHarness) =>
  h.getState().persistent.mods[GAME][COLLECTION]?.attributes?.installCompleted;

/**
 * What the install-finished dialog shows for: a collection with the driver on "review"
 * (InstallFinishedDialog's `show`).
 */
const reviewShown = (h: ICollectionHarness) =>
  h.driver.collection !== undefined && h.driver.step === "review";

describe("InstallDriver game-version prompt", () => {
  test("Cancel from the install dialog ends the install and nothing later begins it", async ({
    makeCollection,
  }) => {
    const h = makeCollection(mismatchedGameVersion());
    const { begun, updates } = withExtensionHandler(h);
    await openInstallDialog(h);
    h.setNextDialog({ action: "Cancel", input: {} });

    // "Install Now"
    await h.driver.continue();
    await settle();

    expect(h.dialogCalls.map((call) => call.title)).toEqual(["Game version mismatch"]);
    // back to the state a collection nobody is installing leaves, as "Later" does; the update
    // lets the install dialog close
    expect(h.driver.step).toBe("prepare");
    expect(h.driver.collection).toBeUndefined();
    const updatesAtCancel = updates();
    expect(updatesAtCancel).toBeGreaterThan(1);

    // an unrelated mod install updates the driver, then "Install Now" is pressed again
    h.emit("did-install-mod", GAME, "other-archive", "other-mod");
    await h.driver.continue();
    await settle();

    expect(updates()).toBeGreaterThan(updatesAtCancel);
    expect(begun).toEqual([]);
    expect(h.getState().session.collections.activeSession).toBeUndefined();
  });

  test("Cancel when resuming an install does not begin it", async ({ makeCollection }) => {
    const h = makeCollection(mismatchedGameVersion());
    const { begun } = withExtensionHandler(h);
    h.setNextDialog({ action: "Cancel", input: {} });

    // resume (the notification, resume-collection) is driver.start
    await h.installRevision(makeRevision(1, [{ tag: "a" }], { collectionId: COLLECTION }));
    await settle();

    expect(h.dialogCalls.map((call) => call.title)).toEqual(["Game version mismatch"]);
    expect(begun).toEqual([]);
    expect(h.driver.step).toBe("prepare");
    expect(h.driver.collection).toBeUndefined();
  });

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
    let answer: (result: IDialogResult) => void = () => undefined;
    const showDialog = vi.fn(() => new Promise<IDialogResult>((resolve) => (answer = resolve)));
    (h.api as { showDialog: unknown }).showDialog = showDialog;

    const installNow = h.driver.continue();
    await vi.waitFor(() => expect(showDialog).toHaveBeenCalled());
    h.emit("did-install-mod", GAME, "other-archive", "other-mod");
    await settle();

    expect(begun).toEqual([]);

    answer({ action: "Continue", input: {} });
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
    let answer: (result: IDialogResult) => void = () => undefined;
    const showDialog = vi.fn(() => new Promise<IDialogResult>((resolve) => (answer = resolve)));
    (h.api as { showDialog: unknown }).showDialog = showDialog;

    const installNow = h.driver.continue();
    await vi.waitFor(() => expect(showDialog).toHaveBeenCalled());
    // logout and game switch pause the install through pauseCollection
    h.driver.pause("logout");
    answer({ action: "Continue", input: {} });
    await installNow;
    await settle();

    expect(begun).toEqual([]);
    expect(h.driver.step).toBe("prepare");
    expect(h.getState().session.collections.activeSession).toBeUndefined();
  });

  test("answering a paused attempt's prompt does not let a newer attempt begin early", async ({
    makeCollection,
  }) => {
    const h = makeCollection(mismatchedGameVersion());
    const { begun } = withExtensionHandler(h);
    const revision = await openInstallDialog(h);
    const answers: Array<(result: IDialogResult) => void> = [];
    const showDialog = vi.fn(() => new Promise<IDialogResult>((resolve) => answers.push(resolve)));
    (h.api as { showDialog: unknown }).showDialog = showDialog;

    const installNow = h.driver.continue();
    await vi.waitFor(() => expect(showDialog).toHaveBeenCalledTimes(1));
    h.driver.pause("logout");
    // resumed (resume-collection) while the first prompt is still open, which asks again
    const resume = h.installRevision(revision);
    await vi.waitFor(() => expect(showDialog).toHaveBeenCalledTimes(2));

    answers[0]({ action: "Continue", input: {} });
    await installNow;
    h.emit("did-install-mod", GAME, "other-archive", "other-mod");
    await settle();

    expect(begun).toEqual([]);

    answers[1]({ action: "Continue", input: {} });
    await resume;
    await settle();

    expect(begun).toEqual([[COLLECTION]]);
  });

  test("a resume right after a finished install does not review it while the prompt is open", async ({
    makeCollection,
  }) => {
    const h = makeCollection(mismatchedGameVersion());
    const { begun } = withExtensionHandler(h);
    await completeAnotherInstall(h);
    let answer: (result: IDialogResult) => void = () => undefined;
    const showDialog = vi.fn(() => new Promise<IDialogResult>((resolve) => (answer = resolve)));
    (h.api as { showDialog: unknown }).showDialog = showDialog;

    const resume = h.installRevision(makeRevision(1, [{ tag: "b" }], { collectionId: COLLECTION }));
    await vi.waitFor(() => expect(showDialog).toHaveBeenCalled());
    h.emit("did-install-mod", GAME, "other-archive", "other-mod");
    await settle();

    // the previous install's "review" must not carry over to this collection
    expect(reviewShown(h)).toBe(false);
    expect(installCompleted(h)).toBeUndefined();
    expect(begun).toEqual([[PREVIOUS]]);
    expect(h.driver.step).toBe("start");

    answer({ action: "Cancel", input: {} });
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
