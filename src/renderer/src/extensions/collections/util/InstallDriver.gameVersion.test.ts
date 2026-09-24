/**
 * When a collection revision lists game versions and none matches the installed game, the driver
 * asks whether to go on ("Game version mismatch", Cancel / Continue). These tests drive the REAL
 * driver through the collection harness, with the collections extension's own onUpdate handler
 * (index.ts), which continues the driver whenever it sits on the "start" step.
 *
 * The regression they pin: Cancel left the driver on "start" with the collection still set, so
 * the next driver update, or a second "Install Now", began the install anyway.
 */
import { describe, expect, vi } from "vitest";

import { makeCollectionModInfo, makeDownload, makeRevision } from "../../../test-utils/builders";
import { test } from "../../../test-utils/collectionTest";
import type { ICollectionHarness } from "../../../test-utils/harnessTypes";
import type { IDialogResult } from "../../../types/IDialog";
import type { IProfile } from "../../profile_management/types/IProfile";

const GAME = "skyrimse";
const COLLECTION = "col-1";
const ARCHIVE = `dl-${COLLECTION}`;

/** The collection download, carrying revision info that asks for a game version not installed. */
function mismatchedGameVersion() {
  const modInfo = makeCollectionModInfo({ collectionId: 1, revisionId: 2, gameId: GAME });
  // revision info on the download, so the driver reads it without a network fetch; the
  // harness game reports 1.0.0
  modInfo.nexus.revisionInfo = { modFiles: [], gameVersions: [{ reference: "9.9.9" }] };
  return { downloads: { [ARCHIVE]: makeDownload({ id: ARCHIVE, state: "finished", modInfo }) } };
}

/**
 * Wire up what the collections extension adds around the driver: its onUpdate handler, which
 * continues from "start" (index.ts, "currently no UI associated with the start step"), and a
 * count of the install-dependencies events that actually begin an install.
 */
function withExtensionHandler(h: ICollectionHarness) {
  const begun: string[][] = [];
  h.api.events.on("install-dependencies", (_profileId: string, _gameId: string, ids: string[]) =>
    begun.push(ids),
  );
  let updates = 0;
  h.driver.onUpdate(() => {
    updates += 1;
    if (h.driver.step === "start") {
      void h.driver.continue();
    }
  });
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
});
