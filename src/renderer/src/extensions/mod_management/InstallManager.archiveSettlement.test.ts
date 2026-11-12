import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, vi } from "vitest";

import { makeDownload, makeGameStored, makeProfile } from "../../test-utils/builders";
import { test as imTest } from "../../test-utils/installManagerTest";
import { makeTempDir } from "../../test-utils/tempDir";
import ConcurrencyLimiter from "../../util/ConcurrencyLimiter";
import { ArchiveBrokenError } from "../../util/CustomErrors";

describe("damaged archive installation settlement", () => {
  imTest.for([
    { unattended: false, beforeContext: false, throws: false },
    { unattended: false, beforeContext: false, throws: true },
    { unattended: true, beforeContext: false, throws: true },
    { unattended: false, beforeContext: true, throws: true },
    { unattended: true, beforeContext: false },
    { unattended: false, beforeContext: true },
  ])(
    "settles once and releases its slot: %j",
    async ({ unattended, beforeContext, throws }, { makeInstallManager }) => {
      const h = makeInstallManager({
        profiles: { "profile-1": makeProfile() },
        activeProfileId: "profile-1",
        knownGames: [makeGameStored({ id: "skyrimse" })],
        discovered: { skyrimse: { path: "C:/test-game" } },
        downloads: { broken: makeDownload({ state: "finished" }) },
      });
      const error = new ArchiveBrokenError("broken.7z", "Unexpected end of archive");
      if (beforeContext) vi.spyOn(h.api, "genMd5Hash").mockRejectedValue(error);
      else h.api.lookupModMeta = vi.fn().mockRejectedValue(error);
      const internals = h.manager as unknown as {
        mInstallLimit: ConcurrencyLimiter;
        mActiveInstalls: Map<string, unknown>;
      };
      internals.mInstallLimit = new ConcurrencyLimiter(1);
      const limiter = vi.spyOn(internals.mInstallLimit, "do");
      const callback = vi.fn(() => {
        if (throws) throw new Error("caller failed");
      });
      h.manager.install(
        "broken",
        "broken.7z",
        ["skyrimse"],
        h.api,
        {},
        false,
        false,
        callback,
        "skyrimse",
        undefined,
        unattended,
      );
      const promise = limiter.mock.results[0].value as Promise<unknown>;
      const next = internals.mInstallLimit.do(() => Promise.resolve("next"));
      let outcome: unknown;
      const settled = promise.then(
        (value) => {
          outcome = { rejected: false, value };
        },
        (failure) => {
          outcome = { rejected: true, value: failure };
        },
      );
      await vi.waitFor(() => expect(outcome).toEqual({ rejected: true, value: error }));
      await settled;
      await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));
      expect(callback).toHaveBeenCalledWith(error, null);
      expect(internals.mActiveInstalls.size).toBe(0);
      await expect(next).resolves.toBe("next");
      expect(callback).toHaveBeenCalledTimes(1);
      expect(
        h.notifications.filter((n) => n.title === "Installation failed, archive is damaged"),
      ).toHaveLength(!unattended && !beforeContext ? 1 : 0);
      expect(h.getState().persistent.downloads.files.broken.state).toBe("failed");
      expect(h.dispatched.filter((a) => a.type === "SHOW_MODAL_DIALOG")).toHaveLength(0);
    },
  );
  imTest(
    "old completion preserves an install started by its callback with the same key",
    async ({ makeInstallManager }) => {
      const h = makeInstallManager({
        profiles: { "profile-1": makeProfile() },
        activeProfileId: "profile-1",
        knownGames: [makeGameStored({ id: "skyrimse" })],
        discovered: { skyrimse: { path: "C:/test-game" } },
        downloads: { broken: makeDownload({ state: "finished" }) },
      });
      const firstError = new ArchiveBrokenError("first.7z", "Unexpected end of archive");
      const secondError = new ArchiveBrokenError("second.7z", "Unexpected end of archive");
      const deferred = Promise.withResolvers<never>();
      const lookup = vi
        .fn()
        .mockRejectedValueOnce(firstError)
        .mockImplementationOnce(() => deferred.promise);
      h.api.lookupModMeta = lookup;
      const internals = h.manager as unknown as {
        mInstallLimit: ConcurrencyLimiter;
        mActiveInstalls: Map<string, { archivePath: string }>;
      };
      internals.mInstallLimit = new ConcurrencyLimiter(1);
      const limiter = vi.spyOn(internals.mInstallLimit, "do");
      const secondCallback = vi.fn();
      const firstCallback = vi.fn(() => {
        h.setState((state) => {
          state.persistent.downloads.files.broken.state = "finished";
        });
        h.manager.install(
          "broken",
          "second.7z",
          ["skyrimse"],
          h.api,
          {},
          false,
          false,
          secondCallback,
          "skyrimse",
        );
      });
      h.manager.install(
        "broken",
        "first.7z",
        ["skyrimse"],
        h.api,
        {},
        false,
        false,
        firstCallback,
        "skyrimse",
      );
      await expect(limiter.mock.results[0].value as Promise<unknown>).rejects.toBe(firstError);
      await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(2));
      expect(internals.mActiveInstalls.size).toBe(1);
      expect([...internals.mActiveInstalls.values()][0].archivePath).toBe("second.7z");
      expect(secondCallback).not.toHaveBeenCalled();
      deferred.reject(secondError);
      await expect(limiter.mock.results[1].value as Promise<unknown>).rejects.toBe(secondError);
      await vi.waitFor(() => expect(secondCallback).toHaveBeenCalledTimes(1));
      expect(firstCallback).toHaveBeenCalledTimes(1);
      expect(firstCallback).toHaveBeenCalledWith(firstError, null);
      expect(secondCallback).toHaveBeenCalledWith(secondError, null);
      expect(internals.mActiveInstalls.size).toBe(0);
    },
  );
  imTest(
    "a successful install retains its files and completion event when its caller throws",
    async ({ makeInstallManager }) => {
      const root = await makeTempDir("vortex-callback-success-");
      const h = makeInstallManager({
        profiles: { "profile-1": makeProfile() },
        activeProfileId: "profile-1",
        knownGames: [makeGameStored({ id: "skyrimse" })],
        discovered: { skyrimse: { path: "C:/test-game" } },
        installPath: { skyrimse: root },
        downloads: { valid: makeDownload({ state: "finished" }) },
      });
      h.api.lookupModMeta = vi.fn().mockResolvedValue([]);
      const internals = h.manager as unknown as {
        mInstallLimit: ConcurrencyLimiter;
        mGetInstallPath: (game: string) => string;
        mActiveInstalls: Map<string, unknown>;
        installInner: (...args: unknown[]) => Promise<{ instructions: unknown[] }>;
        processInstructions: (...args: unknown[]) => Promise<void>;
      };
      internals.mGetInstallPath = () => root;
      internals.mInstallLimit = new ConcurrencyLimiter(1);
      // Extraction/instruction stand-ins create the payload; the real outer install owns
      // success, notification, callback, cleanup, Redux publication and did-install-mod.
      vi.spyOn(internals, "installInner").mockResolvedValue({ instructions: [] });
      vi.spyOn(internals, "processInstructions").mockImplementation(async (...args) => {
        const destination = args[4] as string;
        await mkdir(destination, { recursive: true });
        await writeFile(path.join(destination, "proof.txt"), "installed");
      });
      const completed = vi.fn();
      h.api.events.on("did-install-mod", completed);
      const callback = vi.fn(() => {
        throw new Error("caller failed after success");
      });
      const limiter = vi.spyOn(internals.mInstallLimit, "do");
      h.manager.install(
        "valid",
        "valid.7z",
        ["skyrimse"],
        h.api,
        {},
        false,
        false,
        callback,
        "skyrimse",
      );
      await expect(limiter.mock.results[0].value as Promise<unknown>).resolves.toBe("valid");
      await vi.waitFor(() => expect(completed).toHaveBeenCalledTimes(1));
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(null, "valid");
      expect(await readFile(path.join(root, "valid", "proof.txt"), "utf8")).toBe("installed");
      expect(h.getState().persistent.mods.skyrimse.valid.state).toBe("installed");
      expect(internals.mActiveInstalls.size).toBe(0);
      await expect(internals.mInstallLimit.do(() => Promise.resolve("next"))).resolves.toBe("next");
    },
  );
});
