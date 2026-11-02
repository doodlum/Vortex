import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import type * as FsPromises from "node:fs/promises";
import * as path from "node:path";

import PromiseBB from "bluebird";
import { expect, vi } from "vitest";

// util/Steam reads paths at import time and there is no ApplicationData here
vi.mock("../../util/getVortexPath", () => ({ default: vi.fn(() => "/tmp") }));
const nativeFault = vi.hoisted(() => ({
  target: undefined as string | undefined,
  called: vi.fn(),
}));
vi.mock("node:fs/promises", async (original) => {
  const real = await original<typeof FsPromises>();
  const mocked = {
    ...real,
    unlink: async (file: Parameters<typeof real.unlink>[0]) => {
      if (file === nativeFault.target) {
        nativeFault.called();
        throw new Error("locked native file");
      }
      return real.unlink(file);
    },
  };
  return { ...mocked, default: mocked };
});

import { makeRealDeploymentMethod } from "../../test-utils/builders";
import { makeDeployedGame } from "../../test-utils/deployedGame";
import { test } from "../../test-utils/harnessTest";
import { ProcessCanceled, TemporaryError, UserCanceled } from "../../util/CustomErrors";
import * as vortexFs from "../../util/fs";
import {
  forgetVirtualFiles,
  gameOwnerPrefix,
  setVirtualFiles,
  virtualSource,
} from "../../util/vfsFsView";
import hardlinkInit from "../hardlink_activator";
import VirtualDeployment, { VFS_DEPLOYMENT_ID } from "../vfs_deployment/VirtualDeployment";
import { METHOD_UPGRADED_NOTIFICATION_ID } from "./constants";
import { onGameModeActivated } from "./eventHandlers";
import { getManifest } from "./util/activationStore";
import * as activationStore from "./util/activationStore";
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

test("links an older Vortex deployed again under the virtual method are purged", async () => {
  const game = await makeDeployedGame({ methodId: "hardlink_activator", stagingTag: true });
  const hardlink = makeRealDeploymentMethod(game.api, hardlinkInit);
  registerDeploymentMethod(hardlink);
  const original = path.join(game.dataPath, "ReplacedByMod.esp");
  mkdirSync(game.dataPath, { recursive: true });
  writeFileSync(original, "the game's own file");
  // Installed long before the mod (a purge tells its own files apart by time).
  const installed = new Date(Date.now() - 3600_000);
  utimesSync(original, installed, installed);
  await game.deployMods(hardlink, ["ReplacedByMod"]);
  // The older Vortex kept the virtual method's id in the settings it did not know.
  game.setState((draft) => {
    draft.settings.mods.activator[game.gameId] = VFS_DEPLOYMENT_ID;
  });

  onGameModeActivated(game.api, [virtual, hardlink], game.gameId);
  await vi.waitFor(() => expect(statSync(original).nlink).toBe(1));

  await vi.waitFor(() =>
    expect(game.dispatched).toContainEqual(
      expect.objectContaining({
        type: "SET_NEED_DEPLOYMENT",
        payload: expect.objectContaining({ gameId: game.gameId, required: true }),
      }),
    ),
  );
  expect(readFileSync(original, "utf8")).toBe("the game's own file");
  expect(existsSync(`${original}.vortex_backup`)).toBe(false);
  // Nothing is left for the next start to purge.
  expect((await getManifest(game.api, "", game.gameId, false)).files).toEqual([]);
  expect(game.notifications.map((n) => n.id)).toContain(METHOD_UPGRADED_NOTIFICATION_ID);
  expect(game.errorNotifications).toEqual([]);
});

test("a virtual game with no links left behind is left alone", async () => {
  const game = await makeDeployedGame({ methodId: VFS_DEPLOYMENT_ID, stagingTag: true });
  onGameModeActivated(game.api, [virtual], game.gameId);
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(game.dispatched.map((action) => action.type)).not.toContain("SET_NEED_DEPLOYMENT");
  expect(game.notifications).toEqual([]);
  expect(game.errorNotifications).toEqual([]);
});

for (const implementation of ["native", "bluebird"] as const) {
  for (const fault of ["unlink", "restore-backup"] as const) {
    test(`migration keeps its recovery state when the real link method fails to ${fault} (${implementation} Promise)`, async () => {
      const game = await makeDeployedGame({ methodId: "hardlink_activator", stagingTag: true });
      const hardlink = makeRealDeploymentMethod(game.api, hardlinkInit);
      registerDeploymentMethod(hardlink);
      const original = path.join(game.dataPath, "ReplacedByMod.esp");
      mkdirSync(game.dataPath, { recursive: true });
      writeFileSync(original, "the game's original");
      await game.deployMods(hardlink, ["ReplacedByMod"]);
      const backup = `${original}.vortex_backup`;
      const unlink = vortexFs.unlinkAsync;
      const rename = vortexFs.renameAsync;
      const nativeUnlink = fault === "unlink" && process.platform !== "win32";
      if (nativeUnlink) nativeFault.target = original;
      const spy = nativeUnlink
        ? nativeFault.called
        : fault === "unlink"
          ? vi
              .spyOn(vortexFs, "unlinkAsync")
              .mockImplementation((file, ...args) =>
                file === original
                  ? PromiseBB.reject(new TemporaryError("locked file"))
                  : unlink(file, ...args),
              )
          : vi
              .spyOn(vortexFs, "renameAsync")
              .mockImplementation((from, to) =>
                from === backup ? PromiseBB.reject(new UserCanceled()) : rename(from, to),
              );
      if (fault === "restore-backup") game.setNextDialog({ action: "Really cancel", input: {} });
      const previousPromise = globalThis.Promise;
      if (implementation === "bluebird") vi.stubGlobal("Promise", PromiseBB);
      try {
        onGameModeActivated(game.api, [virtual, hardlink], game.gameId);
        await vi.waitFor(() => expect(spy).toHaveBeenCalled());
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(game.dispatched.map((action) => action.type)).not.toContain("SET_ACTIVATOR");
        expect(game.notifications.map((notification) => notification.id)).not.toContain(
          METHOD_UPGRADED_NOTIFICATION_ID,
        );
        expect(readFileSync(backup, "utf8")).toBe("the game's original");
        expect((await getManifest(game.api, "", game.gameId, false)).files).toHaveLength(1);
        spy.mockRestore();
        nativeFault.target = undefined;
        onGameModeActivated(game.api, [virtual, hardlink], game.gameId);
        await vi.waitFor(() =>
          expect(game.dispatched.map((action) => action.type)).toContain("SET_ACTIVATOR"),
        );
        expect(readFileSync(original, "utf8")).toBe("the game's original");
        expect(existsSync(backup)).toBe(false);
      } finally {
        spy.mockRestore();
        nativeFault.target = undefined;
        vi.stubGlobal("Promise", previousPromise);
      }
    });
  }
}

for (const step of ["prePurge", "purge", "saveManifest", "postPurge"] as const) {
  for (const recovery of [false, true]) {
    test(`a failed ${step} preserves migration state and the virtual view (${recovery ? "downgrade recovery" : "first upgrade"})`, async () => {
      const game = await makeDeployedGame({ methodId: "hardlink_activator", stagingTag: true });
      const hardlink = makeRealDeploymentMethod(game.api, hardlinkInit);
      registerDeploymentMethod(hardlink);
      const original = path.join(game.dataPath, "ReplacedByMod.esp");
      mkdirSync(game.dataPath, { recursive: true });
      writeFileSync(original, "the game's own file");
      const installed = new Date(Date.now() - 3600_000);
      utimesSync(original, installed, installed);
      await game.deployMods(hardlink, ["ReplacedByMod"]);
      if (recovery) {
        game.setState((draft) => {
          draft.settings.mods.activator[game.gameId] = VFS_DEPLOYMENT_ID;
        });
      }
      const owner = `${gameOwnerPrefix(game.gameId)}failure-${step}`;
      const virtualFile = path.join(game.dataPath, "only-virtual.esp");
      const staged = path.join(game.stagingPath, "virtual-source.esp");
      writeFileSync(staged, "a virtual mod");
      setVirtualFiles(owner, [game.dataPath], [{ deployed: virtualFile, source: staged }]);
      const failure =
        step === "prePurge"
          ? new ProcessCanceled("purge canceled")
          : new TemporaryError("purge unavailable");
      const spy =
        step === "saveManifest"
          ? vi.spyOn(activationStore, "savePurgeLeftovers").mockRejectedValueOnce(failure)
          : vi.spyOn(hardlink, step).mockRejectedValueOnce(failure);
      // Completion of the protected cleanup, even when preparation fails, is observable.
      const post = step === "postPurge" ? spy : vi.spyOn(hardlink, "postPurge");
      try {
        onGameModeActivated(game.api, [virtual, hardlink], game.gameId);
        await vi.waitFor(() => expect(post).toHaveBeenCalled());
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(game.dispatched.map((action) => action.type)).not.toContain("SET_ACTIVATOR");
        expect(game.dispatched.map((action) => action.type)).not.toContain("SET_NEED_DEPLOYMENT");
        expect(game.notifications.map((notification) => notification.id)).not.toContain(
          METHOD_UPGRADED_NOTIFICATION_ID,
        );
        expect(virtualSource(virtualFile)).toBe(staged);
        if (step === "prePurge" || step === "purge") {
          expect(statSync(original).nlink).toBeGreaterThan(1);
          expect(readFileSync(`${original}.vortex_backup`, "utf8")).toBe("the game's own file");
          expect((await getManifest(game.api, "", game.gameId, false)).files).toHaveLength(1);
        }
        spy.mockRestore();
        post.mockRestore();
        onGameModeActivated(game.api, [virtual, hardlink], game.gameId);
        await vi.waitFor(() =>
          expect(game.dispatched).toContainEqual(
            expect.objectContaining({
              type: "SET_NEED_DEPLOYMENT",
              payload: expect.objectContaining({ gameId: game.gameId, required: true }),
            }),
          ),
        );
        expect(readFileSync(original, "utf8")).toBe("the game's own file");
        expect(existsSync(`${original}.vortex_backup`)).toBe(false);
      } finally {
        spy.mockRestore();
        post.mockRestore();
        forgetVirtualFiles(owner);
      }
    });
  }
}
