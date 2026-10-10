import { createHash } from "node:crypto";
/**
 * A collection member whose archive name is already taken in the download folder (LAZ-1286).
 *
 * The download adapter reuses an on-disk file by name alone. For a member that pins one exact file
 * (a non-fuzzy version with a file hash) a same-named file with another hash, such as a truncated
 * copy, must not be reused or tagged as the member, or every retry installs the same bad file. A
 * same-named copy that is the right file must still be reused without a download (LAZ-972).
 */
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";

import { VortexError } from "@vortex/shared";
import { AlreadyDownloaded } from "@vortex/shared/errors";
import { beforeEach, describe, expect, vi } from "vitest";

import {
  makeDownload,
  makeExactRef,
  makeFuzzyRef,
  makeInstallState,
  makeMod,
  makeModInstallInfo,
  makeProfile,
  makeRule,
  makeSession,
  managerInternals as internals,
} from "../../test-utils/builders";
import type { IInstallManagerHarness } from "../../test-utils/harnessTypes";
import { test as imTest } from "../../test-utils/installManagerTest";
import { makeTempDir } from "../../test-utils/tempDir";
import { generateCollectionSessionId, modRuleId } from "../../util/collectionInstallSession";
import { MOD_TYPE } from "../collections/constants";
import { downloadPathForGame } from "../download_management/selectors";
import type { IDownload } from "../download_management/types/IDownload";
import type { IDependency } from "./types/IDependency";
import type { IModReference } from "./types/IMod";
import type * as Dependencies from "./util/dependencies";
import { OPTIONAL_PHASE } from "./util/rulePhase";
import { downloadReferenceTags } from "./util/testModReference";

vi.mock("../../logging", () => ({ log: vi.fn() }));

const gather = vi.hoisted(() => vi.fn());
vi.mock("./util/dependencies", async (original) => ({
  ...(await original<object>()),
  default: gather,
}));

const hashFile = vi.hoisted(() => vi.fn<(filePath: string) => Promise<string>>());
vi.mock("../../util/checksum", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fileMD5: hashFile,
}));

beforeEach(() => {
  gather.mockReset();
  hashFile.mockReset();
  hashFile.mockImplementation(async (filePath) =>
    createHash("md5")
      .update(await readFile(filePath))
      .digest("hex"),
  );
});

const GAME = "skyrimse";
const PROFILE = "prof-1";
const COLLECTION = "col-1";
const ARCHIVE = "Member-100-1-0.7z";
const GOOD_MD5 = createHash("md5").update(Buffer.alloc(1000)).digest("hex");
const GOOD_SIZE = 1000;
const TAG = "member-tag";

const exactRef = makeExactRef({
  tag: TAG,
  gameId: GAME,
  fileMD5: GOOD_MD5,
  fileSize: GOOD_SIZE,
  versionMatch: "1.0.0",
});

interface IFakeDisk {
  files: Set<string>;
  starts: Array<{ fileName: string; redownload: string }>;
  removed: string[];
}

/**
 * Stands in for IPCDownloadAdapter's start-download and remove-download: a name already on disk is
 * reused with AlreadyDownloaded and the record that tracks it (the adapter checks neither size nor
 * hash), anything else downloads the good file under that name; remove-download deletes the file
 * and its record.
 */
function fakeAdapter(
  h: IInstallManagerHarness,
  onDisk: string[],
  options: {
    firstError?: Error;
    freshMD5?: string;
    freshSize?: number;
    emitFinished?: boolean;
  } = {},
): IFakeDisk {
  const disk: IFakeDisk = { files: new Set(onDisk), starts: [], removed: [] };
  h.api.events.on(
    "start-download",
    (
      _urls: unknown,
      _modInfo: unknown,
      fileName: string,
      callback: (err: Error | null, id?: string) => void,
      redownload: string,
    ) => {
      disk.starts.push({ fileName, redownload });
      if (disk.starts.length === 1 && options.firstError !== undefined) {
        callback(options.firstError);
        return;
      }
      const files = h.getState().persistent.downloads.files;
      const existing = Object.keys(files).find((id) => files[id].localPath === fileName);
      if (redownload !== "always" && disk.files.has(fileName) && existing !== undefined) {
        callback(new AlreadyDownloaded(fileName, existing));
        return;
      }
      const id = `dl-fresh-${disk.starts.length}`;
      const freshName = disk.files.has(fileName) ? `${id}-${fileName}` : fileName;
      h.setState((draft) => {
        draft.persistent.downloads.files[id] = makeDownload({
          id,
          state: "finished",
          game: [GAME],
          localPath: freshName,
          size: options.freshSize ?? GOOD_SIZE,
          fileMD5: options.freshMD5 ?? GOOD_MD5,
          modInfo: _modInfo as IDownload["modInfo"],
        });
      });
      disk.files.add(freshName);
      if (options.emitFinished) h.api.events.emit("did-finish-download", id, "finished");
      callback(null, id);
    },
  );
  h.api.events.on("remove-download", (id: string, callback?: (err: Error | null) => void) => {
    disk.removed.push(id);
    disk.files.delete(h.getState().persistent.downloads.files[id]?.localPath);
    h.setState((draft) => {
      delete draft.persistent.downloads.files[id];
    });
    callback?.(null);
  });
  return disk;
}

async function makeInstall(
  makeInstallManager: (overrides?: object) => IInstallManagerHarness,
  reference: IModReference,
  existing: IDownload,
) {
  const root = await makeTempDir("reused-member-");
  const rule = makeRule({ type: "requires", reference });
  const h = makeInstallManager({
    profiles: { [PROFILE]: makeProfile({ id: PROFILE, gameId: GAME }) },
    mods: {
      [GAME]: {
        [COLLECTION]: makeMod({
          id: COLLECTION,
          type: MOD_TYPE,
          rules: [rule],
          attributes: { collectionId: 1 },
        }),
      },
    },
    downloads: { [existing.id]: existing },
    session: makeInstallState({
      activeSession: makeSession({
        sessionId: generateCollectionSessionId(COLLECTION, PROFILE),
        collectionId: COLLECTION,
        profileId: PROFILE,
        gameId: GAME,
        mods: {
          [modRuleId(rule)]: makeModInstallInfo({
            rule,
            type: "requires",
            status: "pending",
            phase: 0,
          }),
        },
        totalRequired: 1,
      }),
    }),
  });
  h.setState((draft) => {
    draft.settings.profiles.activeProfileId = PROFILE;
    draft.settings.downloads.path = root;
  });
  const phaseState = h.phaseTracker.ensure(COLLECTION);
  phaseState.allowedPhase = 0;
  const queued = vi
    .spyOn(h.manager as unknown as { queueInstallation: () => void }, "queueInstallation")
    .mockImplementation(() => undefined);
  return { h, rule, queued };
}

/** Run one dependency round for the member until it queued an install, then unwind it. */
async function installMember(
  h: IInstallManagerHarness,
  rule: ReturnType<typeof makeRule>,
  queued: { mock: { calls: unknown[][] } },
  download?: string,
  dependencies?: IDependency[],
): Promise<string> {
  const existing = h.getState().persistent.downloads.files["dl-existing"];
  const dlPath = downloadPathForGame(h.getState(), GAME);
  await mkdir(dlPath, { recursive: true });
  const filePath = path.join(dlPath, existing.localPath);
  if (
    !(await access(filePath).then(
      () => true,
      () => false,
    ))
  )
    await writeFile(filePath, Buffer.alloc(existing.size));
  const installing = internals(h.manager).doInstallDependencies(
    h.api,
    GAME,
    COLLECTION,
    dependencies ?? [
      {
        reference: rule.reference,
        sessionRuleId: modRuleId(rule),
        download,
        phase: 0,
        lookupResults: [
          {
            key: "member",
            value: {
              sourceURI: "https://files.example/Member.7z",
              logicalFileName: "Member",
              domainName: GAME,
              source: "nexus",
            },
          },
        ],
        extra: { fileName: ARCHIVE },
      },
    ],
    false,
    true,
  );
  try {
    // the first round in a file loads the manager's lazy modules, which can outlast waitFor's default
    // second on a loaded machine
    const failed = () =>
      Object.values(h.getState().session.collections.activeSession.mods).some(
        (mod) => mod.status === "failed",
      );
    await vi.waitFor(() => expect(queued.mock.calls.length > 0 || failed()).toBe(true), {
      timeout: 15_000,
    });
    expect(failed()).toBe(false);
    expect(queued.mock.calls.length).toBeGreaterThan(0);
    return queued.mock.calls[0][2] as string;
  } finally {
    internals(h.manager).mDependencyInstalls[COLLECTION]?.();
    delete internals(h.manager).mDependencyInstalls[COLLECTION];
    await installing.catch(() => undefined);
  }
}

const onDisk = (overrides: Partial<IDownload>): IDownload =>
  makeDownload({
    id: "dl-existing",
    state: "finished",
    game: [GAME],
    localPath: ARCHIVE,
    size: GOOD_SIZE,
    ...overrides,
  });

const tagsOf = (h: IInstallManagerHarness, id: string) =>
  downloadReferenceTags(h.getState().persistent.downloads.files[id]);

describe("a same-named archive already in the download folder", () => {
  imTest(
    "is re-downloaded when its recorded hash isn't the member's",
    async ({ makeInstallManager }) => {
      const { h, rule, queued } = await makeInstall(
        makeInstallManager,
        exactRef,
        onDisk({ fileMD5: "truncated-md5", size: GOOD_SIZE / 2 }),
      );
      const disk = fakeAdapter(h, [ARCHIVE]);

      const installed = await installMember(h, rule, queued);

      expect(installed).not.toBe("dl-existing");
      expect(h.getState().persistent.downloads.files[installed].fileMD5).toBe(GOOD_MD5);
      expect(tagsOf(h, installed)).toEqual([TAG]);
      // A different file can belong to another collection; it remains untouched.
      expect(disk.removed).toEqual([]);
      expect(disk.files.has(ARCHIVE)).toBe(true);
      expect(h.getState().persistent.downloads.files["dl-existing"]).toBeDefined();
      expect(hashFile).not.toHaveBeenCalled();
    },
  );

  imTest(
    "is re-downloaded without hashing when its size isn't the member's",
    async ({ makeInstallManager }) => {
      // adopted by name from the folder, so no hash is recorded yet
      const { h, rule, queued } = await makeInstall(
        makeInstallManager,
        exactRef,
        onDisk({ size: GOOD_SIZE / 2 }),
      );
      const disk = fakeAdapter(h, [ARCHIVE]);

      const installed = await installMember(h, rule, queued);

      expect(installed).not.toBe("dl-existing");
      expect(disk.removed).toEqual([]);
      expect(disk.files.has(ARCHIVE)).toBe(true);
      expect(hashFile).not.toHaveBeenCalled();
    },
  );

  imTest(
    "is hashed when nothing is recorded, and re-downloaded on a mismatch",
    async ({ makeInstallManager }) => {
      hashFile.mockResolvedValue("other-md5");
      const { h, rule, queued } = await makeInstall(makeInstallManager, exactRef, onDisk({}));
      const disk = fakeAdapter(h, [ARCHIVE]);

      const installed = await installMember(h, rule, queued);

      expect(hashFile).toHaveBeenCalledTimes(1);
      expect(installed).not.toBe("dl-existing");
      expect(disk.removed).toEqual([]);
      expect(disk.files.has(ARCHIVE)).toBe(true);
    },
  );

  // LAZ-972: an archive another collection (or an earlier install) fetched is reused as it is
  imTest(
    "is reused and tagged, without a download, when it is the member's file",
    async ({ makeInstallManager }) => {
      const { h, rule, queued } = await makeInstall(
        makeInstallManager,
        exactRef,
        onDisk({ fileMD5: GOOD_MD5, modInfo: { referenceTags: ["other"], referenceTag: "other" } }),
      );
      const disk = fakeAdapter(h, [ARCHIVE]);

      const installed = await installMember(h, rule, queued);

      expect(installed).toBe("dl-existing");
      expect(tagsOf(h, "dl-existing")).toEqual(["other", TAG]);
      expect(disk.removed).toEqual([]);
      expect(Object.keys(h.getState().persistent.downloads.files)).toEqual(["dl-existing"]);
    },
  );

  imTest(
    "is reused after hashing it when nothing is recorded and it matches",
    async ({ makeInstallManager }) => {
      hashFile.mockResolvedValue(GOOD_MD5);
      const { h, rule, queued } = await makeInstall(makeInstallManager, exactRef, onDisk({}));
      const disk = fakeAdapter(h, [ARCHIVE]);

      const installed = await installMember(h, rule, queued);

      expect(installed).toBe("dl-existing");
      expect(disk.removed).toEqual([]);
      // Verification does not overwrite download metadata after an asynchronous read.
      expect(h.getState().persistent.downloads.files["dl-existing"].fileMD5).toBeUndefined();
    },
  );

  // a fuzzy version resolves to files with other hashes by design, so the hash isn't checked
  imTest("is reused for a fuzzy member whatever its hash", async ({ makeInstallManager }) => {
    const fuzzyRef = makeFuzzyRef({ tag: TAG, gameId: GAME, fileMD5: GOOD_MD5 });
    const { h, rule, queued } = await makeInstall(
      makeInstallManager,
      fuzzyRef,
      onDisk({ fileMD5: "other-md5", modInfo: { nexus: { ids: { modId: 100, fileId: 5 } } } }),
    );
    const disk = fakeAdapter(h, [ARCHIVE]);

    const installed = await installMember(h, rule, queued, "dl-existing");

    expect(installed).toBe("dl-existing");
    expect(disk.removed).toEqual([]);
  });
});

describe("a member already resolved to an archive with another hash", () => {
  // an earlier version tagged the bad copy as the member, so the gather resolves the rule to it
  imTest(
    "downloads the member's file instead of installing the tagged copy",
    async ({ makeInstallManager }) => {
      const { h, rule, queued } = await makeInstall(
        makeInstallManager,
        exactRef,
        onDisk({ fileMD5: "truncated-md5", modInfo: { referenceTag: TAG, referenceTags: [TAG] } }),
      );
      const disk = fakeAdapter(h, [ARCHIVE]);

      const installed = await installMember(h, rule, queued, "dl-existing");

      expect(installed).not.toBe("dl-existing");
      expect(h.getState().persistent.downloads.files[installed].fileMD5).toBe(GOOD_MD5);
      expect(disk.removed).toEqual([]);
      expect(disk.files.has(ARCHIVE)).toBe(true);
    },
  );
});

describe("an archive whose record no longer describes the file", () => {
  // the hash was recorded when the download finished; the file was cut short afterwards
  imTest(
    "is re-downloaded when its size on disk isn't the member's",
    async ({ makeInstallManager }) => {
      const { h, rule, queued } = await makeInstall(
        makeInstallManager,
        exactRef,
        onDisk({ fileMD5: GOOD_MD5, modInfo: { referenceTag: TAG, referenceTags: [TAG] } }),
      );
      // the real file, cut to half the size its record still says
      const root = await makeTempDir("laz1286-");
      h.setState((draft) => {
        draft.settings.downloads.path = root;
      });
      const dlPath = downloadPathForGame(h.getState(), GAME);
      await mkdir(dlPath, { recursive: true });
      await writeFile(path.join(dlPath, ARCHIVE), Buffer.alloc(GOOD_SIZE / 2));
      const disk = fakeAdapter(h, [ARCHIVE]);

      const installed = await installMember(h, rule, queued, "dl-existing");

      expect(installed).not.toBe("dl-existing");
      expect(disk.removed).toEqual([]);
      expect(disk.files.has(ARCHIVE)).toBe(true);
      expect(hashFile).not.toHaveBeenCalled();
    },
  );

  // an earlier attempt installed the bad copy, which marked the download failed; the adapter still
  // hands it back by name
  imTest("is re-downloaded after it failed to install", async ({ makeInstallManager }) => {
    const { h, rule, queued } = await makeInstall(
      makeInstallManager,
      exactRef,
      onDisk({
        state: "failed",
        fileMD5: "truncated-md5",
        size: GOOD_SIZE / 2,
        modInfo: { referenceTag: TAG, referenceTags: [TAG] },
      }),
    );
    const disk = fakeAdapter(h, [ARCHIVE]);

    const installed = await installMember(h, rule, queued);

    expect(installed).not.toBe("dl-existing");
    expect(disk.removed).toEqual([]);
    expect(disk.files.has(ARCHIVE)).toBe(true);
  });
});

describe("preserving and verifying the actual archive", () => {
  for (const size of [0, GOOD_SIZE / 2]) {
    imTest(
      `preserves a ${size}-byte file even when its old recorded hash matches`,
      async ({ makeInstallManager }) => {
        const { h, rule, queued } = await makeInstall(
          makeInstallManager,
          exactRef,
          onDisk({ fileMD5: GOOD_MD5, modInfo: { referenceTags: ["other-collection"] } }),
        );
        const folder = downloadPathForGame(h.getState(), GAME);
        await mkdir(folder, { recursive: true });
        const original = path.join(folder, ARCHIVE);
        await writeFile(original, Buffer.alloc(size));
        const disk = fakeAdapter(h, [ARCHIVE]);
        const installed = await installMember(h, rule, queued, "dl-existing");
        expect(installed).not.toBe("dl-existing");
        expect((await readFile(original)).length).toBe(size);
        expect(tagsOf(h, "dl-existing")).toEqual(["other-collection"]);
        expect(disk.removed).toEqual([]);
        expect(hashFile).not.toHaveBeenCalled();
      },
    );
  }

  imTest(
    "rejects equal-length replacement bytes despite a formerly matching recorded hash",
    async ({ makeInstallManager }) => {
      const { h, rule, queued } = await makeInstall(
        makeInstallManager,
        exactRef,
        onDisk({ fileMD5: GOOD_MD5 }),
      );
      const folder = downloadPathForGame(h.getState(), GAME);
      await mkdir(folder, { recursive: true });
      const bytes = Buffer.alloc(GOOD_SIZE, 1);
      await writeFile(path.join(folder, ARCHIVE), bytes);
      const disk = fakeAdapter(h, [ARCHIVE]);
      expect(await installMember(h, rule, queued, "dl-existing")).not.toBe("dl-existing");
      expect(await readFile(path.join(folder, ARCHIVE))).toEqual(bytes);
      expect(disk.removed).toEqual([]);
    },
  );

  imTest(
    "does not accept an inaccessible archive as a verified match",
    async ({ makeInstallManager }) => {
      const { h, rule, queued } = await makeInstall(
        makeInstallManager,
        exactRef,
        onDisk({ fileMD5: GOOD_MD5 }),
      );
      hashFile.mockRejectedValue(new Error("EACCES"));
      const disk = fakeAdapter(h, [ARCHIVE]);
      expect(await installMember(h, rule, queued)).not.toBe("dl-existing");
      expect(disk.removed).toEqual([]);
      expect(tagsOf(h, "dl-existing")).toEqual([]);
    },
  );

  imTest(
    "settles cancellation while hashing, and ignores the late mismatch without changing the archive",
    async ({ makeInstallManager }) => {
      const { h } = await makeInstall(
        makeInstallManager,
        exactRef,
        onDisk({ modInfo: { referenceTags: ["other"] } }),
      );
      const folder = downloadPathForGame(h.getState(), GAME);
      await mkdir(folder, { recursive: true });
      const original = path.join(folder, ARCHIVE);
      const bytes = Buffer.alloc(GOOD_SIZE, 2);
      await writeFile(original, bytes);
      let release: (value: string) => void;
      hashFile.mockImplementation(
        () =>
          new Promise<string>((resolve) => {
            release = resolve;
          }),
      );
      const disk = fakeAdapter(h, [ARCHIVE]);
      const controller = new AbortController();
      const before = structuredClone(h.getState().persistent.downloads.files);
      const operation = internals(h.manager).downloadURL(
        h.api,
        { sourceURI: "https://files.example/member.7z", domainName: GAME },
        () => controller.signal.aborted,
        TAG,
        undefined,
        ARCHIVE,
        undefined,
        exactRef,
        controller.signal,
      );
      let didSettle = false;
      const settled = expect(operation)
        .rejects.toMatchObject({ name: "UserCanceled" })
        .finally(() => {
          didSettle = true;
        });
      await vi.waitFor(() => expect(hashFile).toHaveBeenCalledTimes(1));
      controller.abort();
      for (let turn = 0; turn < 12; turn++) await Promise.resolve();
      try {
        expect(didSettle).toBe(true);
        expect(disk.starts).toHaveLength(1);
        expect(disk.removed).toEqual([]);
        expect(h.getState().persistent.downloads.files).toEqual(before);
      } finally {
        release("wrong-md5");
        await settled;
      }
      for (let index = 0; index < 12; index++) await Promise.resolve();
      expect(h.getState().persistent.downloads.files).toEqual(before);
      expect(disk.starts).toHaveLength(1);
      expect(await readFile(original)).toEqual(bytes);
    },
  );

  imTest(
    "rejects a resolved mismatch with no source instead of tagging or installing it",
    async ({ makeInstallManager }) => {
      const { h, rule, queued } = await makeInstall(
        makeInstallManager,
        exactRef,
        onDisk({ fileMD5: "wrong-md5", modInfo: { referenceTags: ["other"] } }),
      );
      const folder = downloadPathForGame(h.getState(), GAME);
      await mkdir(folder, { recursive: true });
      await writeFile(path.join(folder, ARCHIVE), Buffer.alloc(GOOD_SIZE));
      const disk = fakeAdapter(h, [ARCHIVE]);
      vi.spyOn(internals(h.manager), "pollAllPhasesComplete").mockResolvedValue(undefined);
      await internals(h.manager).doInstallDependencies(
        h.api,
        GAME,
        COLLECTION,
        [
          {
            reference: rule.reference,
            sessionRuleId: modRuleId(rule),
            download: "dl-existing",
            phase: 0,
            lookupResults: [],
            extra: {},
          },
        ],
        false,
        true,
      );
      expect(queued).not.toHaveBeenCalled();
      expect(disk.starts).toEqual([]);
      expect(tagsOf(h, "dl-existing")).toEqual(["other"]);
      expect(Object.values(h.getState().session.collections.activeSession.mods)[0].status).toBe(
        "failed",
      );
    },
  );
});

describe("browser fallback and new download results", () => {
  const html = () =>
    new VortexError("Download is HTML", {
      kind: "download:is-html",
      url: "https://files.example/consent",
    });
  const lookup = { sourceURI: "https://files.example/consent", domainName: GAME };

  imTest(
    "keeps the pin after browser fallback and preserves a different same-named archive",
    async ({ makeInstallManager }) => {
      const { h } = await makeInstall(
        makeInstallManager,
        exactRef,
        onDisk({ fileMD5: "other-md5", modInfo: { referenceTags: ["other"] } }),
      );
      const disk = fakeAdapter(h, [ARCHIVE], { firstError: html() });
      vi.spyOn(h.api, "emitAndAwait").mockResolvedValue(["https://files.example/member.7z"]);
      const id = await internals(h.manager).downloadURL(
        h.api,
        lookup,
        () => false,
        TAG,
        undefined,
        ARCHIVE,
        undefined,
        exactRef,
      );
      expect(id).not.toBe("dl-existing");
      expect(disk.starts.map((start) => start.redownload)).toEqual(["never", "never", "always"]);
      expect(tagsOf(h, "dl-existing")).toEqual(["other"]);
      expect(disk.removed).toEqual([]);
    },
  );

  imTest(
    "settles a browser rejection instead of leaving the dependency pending",
    async ({ makeInstallManager }) => {
      const { h } = await makeInstall(makeInstallManager, exactRef, onDisk({}));
      const disk = fakeAdapter(h, [ARCHIVE], { firstError: html() });
      vi.spyOn(h.api, "emitAndAwait").mockRejectedValue(new Error("browser failed"));
      await expect(
        internals(h.manager).downloadURL(
          h.api,
          lookup,
          () => false,
          TAG,
          undefined,
          ARCHIVE,
          undefined,
          exactRef,
        ),
      ).rejects.toThrow("browser failed");
      expect(disk.starts).toHaveLength(1);
      expect(disk.removed).toEqual([]);
    },
  );

  imTest(
    "does not start another download after a canceled browser returns a URL",
    async ({ makeInstallManager }) => {
      const { h } = await makeInstall(makeInstallManager, exactRef, onDisk({}));
      const disk = fakeAdapter(h, [ARCHIVE], { firstError: html() });
      let release: (urls: string[]) => void;
      const browser = vi.spyOn(h.api, "emitAndAwait").mockImplementation(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      const controller = new AbortController();
      const operation = internals(h.manager).downloadURL(
        h.api,
        lookup,
        () => controller.signal.aborted,
        TAG,
        undefined,
        ARCHIVE,
        undefined,
        exactRef,
        controller.signal,
      );
      const settled = expect(operation).rejects.toMatchObject({ name: "UserCanceled" });
      await vi.waitFor(() => expect(browser).toHaveBeenCalledTimes(1));
      controller.abort();
      await settled;
      release(["https://files.example/member.7z"]);
      for (let index = 0; index < 12; index++) await Promise.resolve();
      expect(disk.starts).toHaveLength(1);
      expect(disk.removed).toEqual([]);
    },
  );

  imTest(
    "rejects wrong fresh bytes, removes only their new tracking tag and never queues installation",
    async ({ makeInstallManager }) => {
      const { h, queued } = await makeInstall(
        makeInstallManager,
        exactRef,
        onDisk({ fileMD5: "other-md5", modInfo: { referenceTags: ["other"] } }),
      );
      const disk = fakeAdapter(h, [ARCHIVE], { freshMD5: "wrong-fresh-md5", emitFinished: true });
      await expect(
        internals(h.manager).downloadURL(
          h.api,
          { sourceURI: "https://files.example/member.7z", domainName: GAME },
          () => false,
          TAG,
          undefined,
          ARCHIVE,
          undefined,
          exactRef,
        ),
      ).rejects.toThrow("does not match");
      expect(queued).not.toHaveBeenCalled();
      expect(tagsOf(h, "dl-fresh-2")).toEqual([]);
      expect(tagsOf(h, "dl-existing")).toEqual(["other"]);
      expect(disk.starts).toHaveLength(2);
      expect(disk.removed).toEqual([]);
    },
  );

  imTest(
    "does not reuse or replace a record changed while its file is hashed",
    async ({ makeInstallManager }) => {
      const { h } = await makeInstall(makeInstallManager, exactRef, onDisk({}));
      const folder = downloadPathForGame(h.getState(), GAME);
      await mkdir(folder, { recursive: true });
      await writeFile(path.join(folder, ARCHIVE), Buffer.alloc(GOOD_SIZE));
      let release: (hash: string) => void;
      hashFile.mockImplementation(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      const disk = fakeAdapter(h, [ARCHIVE]);
      const operation = internals(h.manager).downloadURL(
        h.api,
        { sourceURI: "https://files.example/member.7z", domainName: GAME },
        () => false,
        TAG,
        undefined,
        ARCHIVE,
        undefined,
        exactRef,
      );
      const settled = expect(operation).rejects.toThrow("changed while");
      await vi.waitFor(() => expect(hashFile).toHaveBeenCalledTimes(1));
      h.setState((draft) => {
        draft.persistent.downloads.files["dl-existing"].state = "paused";
      });
      release(GOOD_MD5);
      await settled;
      expect(disk.starts).toHaveLength(1);
      expect(disk.removed).toEqual([]);
      expect(h.getState().persistent.downloads.files["dl-existing"].state).toBe("paused");
    },
  );
});

describe("archive admission and dependency operation ownership", () => {
  const depFor = (rule: ReturnType<typeof makeRule>) => ({
    reference: rule.reference,
    sessionRuleId: modRuleId(rule),
    phase: 0,
    download: "dl-existing",
    lookupResults: [],
    extra: {},
  });

  for (const changed of ["path", "game", "folder"] as const) {
    imTest(
      `does not extract a runner record whose ${changed} changes during hashing`,
      async ({ makeInstallManager }) => {
        const { h, rule, queued } = await makeInstall(
          makeInstallManager,
          exactRef,
          onDisk({ fileMD5: GOOD_MD5 }),
        );
        queued.mockRestore();
        const folder = downloadPathForGame(h.getState(), GAME);
        await mkdir(folder, { recursive: true });
        await writeFile(path.join(folder, ARCHIVE), Buffer.alloc(GOOD_SIZE));
        let release!: (hash: string) => void;
        hashFile.mockImplementation(
          () =>
            new Promise<string>((resolve) => {
              release = resolve;
            }),
        );
        const mgr = internals(h.manager);
        mgr.mDependencyInstalls[COLLECTION] = () => undefined;
        const extract = vi.spyOn(mgr, "installModAsync").mockResolvedValue(undefined);
        mgr.startQueuedInstallation(h.api, depFor(rule), "dl-existing", GAME, COLLECTION, false, 0);
        await vi.waitFor(() => expect(hashFile).toHaveBeenCalledTimes(1));
        h.setState((draft) => {
          if (changed === "path")
            draft.persistent.downloads.files["dl-existing"].localPath = "changed.7z";
          if (changed === "game")
            draft.persistent.downloads.files["dl-existing"].game = ["fallout4"];
          if (changed === "folder") draft.settings.downloads.path += "-changed";
        });
        release(GOOD_MD5);
        await vi.waitFor(() => expect(h.phaseTracker.get(COLLECTION).activeByPhase.get(0)).toBe(0));
        expect(extract).not.toHaveBeenCalled();
        expect(h.getState().session.collections.activeSession.mods[modRuleId(rule)].status).toBe(
          "failed",
        );
      },
    );
  }

  imTest(
    "old hash cancellation cannot tear down the replacement dependency round",
    async ({ makeInstallManager }) => {
      const { h, rule } = await makeInstall(
        makeInstallManager,
        exactRef,
        onDisk({ fileMD5: GOOD_MD5 }),
      );
      const folder = downloadPathForGame(h.getState(), GAME);
      await mkdir(folder, { recursive: true });
      await writeFile(path.join(folder, ARCHIVE), Buffer.alloc(GOOD_SIZE));
      const releases: Array<(hash: string) => void> = [];
      hashFile.mockImplementation(() => new Promise<string>((resolve) => releases.push(resolve)));
      const mgr = internals(h.manager);
      const old = mgr.doInstallDependencies(h.api, GAME, COLLECTION, [depFor(rule)], false, true);
      await vi.waitFor(() => expect(releases).toHaveLength(1));
      mgr.mDependencyInstalls[COLLECTION]();
      const replacement = mgr.doInstallDependencies(
        h.api,
        GAME,
        COLLECTION,
        [depFor(rule)],
        false,
        true,
      );
      const replacementOperation = mgr.mDependencyInstalls[COLLECTION];
      const replacementPhase = h.phaseTracker.get(COLLECTION);
      await old;
      await vi.waitFor(() => expect(releases).toHaveLength(2));
      releases[0](GOOD_MD5);
      for (let turn = 0; turn < 12; turn++) await Promise.resolve();
      expect(mgr.mDependencyInstalls[COLLECTION]).toBe(replacementOperation);
      expect(h.phaseTracker.get(COLLECTION)).toBe(replacementPhase);
      expect(h.getState().session.collections.activeSession.mods[modRuleId(rule)].status).toBe(
        "pending",
      );
      replacementOperation();
      await replacement;
      releases[1](GOOD_MD5);
    },
  );

  imTest(
    "does not invoke a late referer after source resolution is canceled",
    async ({ makeInstallManager }) => {
      const { h } = await makeInstall(makeInstallManager, exactRef, onDisk({}));
      let release!: (url: string) => void;
      const sourceURI = () =>
        new Promise<string>((resolve) => {
          release = resolve;
        });
      const referer = vi.fn().mockResolvedValue("https://files.example/");
      const started = vi.fn();
      h.api.events.on("start-download", started);
      const controller = new AbortController();
      const operation = internals(h.manager).downloadURL(
        h.api,
        { sourceURI, referer, domainName: GAME },
        () => controller.signal.aborted,
        TAG,
        undefined,
        ARCHIVE,
        undefined,
        exactRef,
        controller.signal,
      );
      const settled = expect(operation).rejects.toMatchObject({ name: "UserCanceled" });
      controller.abort();
      await settled;
      release("https://files.example/member.7z");
      for (let turn = 0; turn < 12; turn++) await Promise.resolve();
      expect(referer).not.toHaveBeenCalled();
      expect(started).not.toHaveBeenCalled();
    },
  );

  async function optionalInstall(
    makeInstallManager: (overrides?: object) => IInstallManagerHarness,
  ) {
    const { h, rule, queued } = await makeInstall(
      makeInstallManager,
      exactRef,
      onDisk({
        fileMD5: undefined,
        modInfo: { referenceTags: ["foreign"], referenceTag: "foreign" },
      }),
    );
    queued.mockRestore();
    const optional = { ...rule, type: "recommends" as const, ignored: false };
    h.setState((draft) => {
      draft.persistent.mods[GAME][COLLECTION].rules = [optional];
      draft.session.collections.activeSession.mods = {
        [modRuleId(optional)]: makeModInstallInfo({
          rule: optional,
          type: "recommends",
          status: "pending",
          phase: OPTIONAL_PHASE,
        }),
      };
      draft.session.collections.activeSession.totalRequired = 0;
      draft.session.collections.activeSession.totalOptional = 1;
    });
    const folder = downloadPathForGame(h.getState(), GAME);
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, ARCHIVE), Buffer.alloc(GOOD_SIZE));
    const mgr = internals(h.manager);
    const controller = new AbortController();
    const operation = () => controller.abort();
    mgr.mDependencyInstalls[COLLECTION] = operation;
    mgr.mDependencyAbortSignals.set(operation, controller.signal);
    const dep = {
      ...depFor(optional),
      download: undefined,
      lookupResults: [
        {
          key: "optional",
          value: { sourceURI: "https://files.example/member.7z", domainName: GAME },
        },
      ],
      extra: { fileName: ARCHIVE },
    };
    return { h, mgr, optional, controller, dep };
  }

  imTest(
    "queues a verified exact optional with no recorded hash at the trailing phase",
    async ({ makeInstallManager }) => {
      const { h, mgr, optional, controller, dep } = await optionalInstall(makeInstallManager);
      gather.mockResolvedValue([dep]);
      const disk = fakeAdapter(h, [ARCHIVE]);
      mgr.driveSelectedOptionals(h.api, COLLECTION);
      await vi.waitFor(() =>
        expect(h.phaseTracker.get(COLLECTION).pendingByPhase.get(OPTIONAL_PHASE)).toHaveLength(1),
      );
      expect(h.getState().session.collections.activeSession.mods[modRuleId(optional)].status).toBe(
        "downloaded",
      );
      expect(h.getState().persistent.downloads.files["dl-existing"].fileMD5).toBeUndefined();
      expect(tagsOf(h, "dl-existing")).toEqual(["foreign", TAG]);
      expect(disk.starts).toHaveLength(1);
      expect(disk.removed).toEqual([]);

      const extracted = vi.spyOn(mgr, "installModAsync").mockImplementation(async () => {
        h.setState((draft) => {
          draft.persistent.mods[GAME]["optional-installed"] = makeMod({
            id: "optional-installed",
            state: "installed",
            attributes: { fileMD5: GOOD_MD5, referenceTag: TAG },
          });
        });
        return "optional-installed";
      });
      h.phaseTracker.get(COLLECTION).allowedPhase = OPTIONAL_PHASE;
      const start = h.phaseTracker.get(COLLECTION).pendingByPhase.get(OPTIONAL_PHASE)[0];
      start();
      await vi.waitFor(() =>
        expect(
          h.getState().session.collections.activeSession.mods[modRuleId(optional)].status,
        ).toBe("installed"),
      );
      expect(extracted).toHaveBeenCalledTimes(1);
      controller.abort();
    },
  );

  async function gatheredOptional(
    makeInstallManager: (overrides?: object) => IInstallManagerHarness,
    mode: "direct" | "browse",
    invalid = false,
  ) {
    const fixture = await optionalInstall(makeInstallManager);
    const { h, optional } = fixture;
    optional.downloadHint = { mode, url: invalid ? "" : "https://files.example/Member.7z" };
    const browse = vi.fn().mockResolvedValue(["https://files.example/Member.7z"]);
    h.setState((draft) => {
      draft.persistent.mods[GAME][COLLECTION].rules = [optional];
      draft.persistent.downloads.files["dl-existing"].modInfo.referenceTags = ["foreign", TAG];
    });
    Object.assign(h.api, {
      lookupModReference: vi.fn().mockResolvedValue([]),
      lookupModMeta: vi.fn().mockResolvedValue([]),
      emitAndAwait: browse,
    });
    const real = await vi.importActual<typeof Dependencies>("./util/dependencies");
    const deps = await real.default([optional], h.api, true);
    expect(deps).toHaveLength(1);
    expect(deps[0].download).toBe("dl-existing");
    expect(deps[0].lookupResults).toEqual([]);
    expect(browse).not.toHaveBeenCalled();
    // Gathering identified the candidate; tag admission must preserve another collection's tag.
    h.setState((draft) => {
      draft.persistent.downloads.files["dl-existing"].modInfo.referenceTags = ["foreign"];
    });
    gather.mockResolvedValue(deps);
    return { ...fixture, browse, folder: downloadPathForGame(h.getState(), GAME) };
  }

  for (const mode of ["direct", "browse"] as const) {
    imTest(
      "reuses a gathered selected optional before resolving its " + mode + " hint",
      async ({ makeInstallManager }) => {
        const { h, mgr, optional, controller, browse } = await gatheredOptional(
          makeInstallManager,
          mode,
          mode === "direct",
        );
        const disk = fakeAdapter(h, [ARCHIVE]);
        try {
          mgr.driveSelectedOptionals(h.api, COLLECTION);
          await vi.waitFor(() =>
            expect(
              h.getState().session.collections.activeSession.mods[modRuleId(optional)].status,
            ).not.toBe("downloading"),
          );
          expect(
            h.getState().session.collections.activeSession.mods[modRuleId(optional)].status,
          ).toBe("downloaded");
          expect(h.phaseTracker.get(COLLECTION).pendingByPhase.get(OPTIONAL_PHASE)).toHaveLength(1);
          expect(disk.starts).toEqual([]);
          expect(browse).not.toHaveBeenCalled();
          expect(tagsOf(h, "dl-existing")).toEqual(["foreign", TAG]);
          expect(h.getState().persistent.downloads.files["dl-existing"].fileMD5).toBeUndefined();
        } finally {
          controller.abort();
        }
      },
    );
  }

  imTest(
    "a gathered stale selected optional resolves its replacement hint once",
    async ({ makeInstallManager }) => {
      const { h, mgr, optional, controller, folder } = await gatheredOptional(
        makeInstallManager,
        "direct",
      );
      await writeFile(path.join(folder, ARCHIVE), Buffer.alloc(GOOD_SIZE, 1));
      const disk = fakeAdapter(h, [ARCHIVE]);
      try {
        mgr.driveSelectedOptionals(h.api, COLLECTION);
        await vi.waitFor(() =>
          expect(
            h.getState().session.collections.activeSession.mods[modRuleId(optional)].status,
          ).not.toBe("downloading"),
        );
        expect(
          h.getState().session.collections.activeSession.mods[modRuleId(optional)].status,
        ).toBe("downloaded");
        expect(disk.starts).toHaveLength(1);
        expect(tagsOf(h, "dl-existing")).toEqual(["foreign"]);
        expect(tagsOf(h, "dl-fresh-1")).toContain(TAG);
        expect(await readFile(path.join(folder, ARCHIVE))).toEqual(Buffer.alloc(GOOD_SIZE, 1));
      } finally {
        controller.abort();
      }
    },
  );

  for (const change of ["cancel", "record"] as const) {
    imTest(
      "a gathered optional cannot tag or queue after " + change + " during hashing",
      async ({ makeInstallManager }) => {
        const { h, mgr, optional, controller } = await gatheredOptional(
          makeInstallManager,
          "direct",
          true,
        );
        let release!: (hash: string) => void;
        hashFile.mockImplementation(
          () =>
            new Promise<string>((resolve) => {
              release = resolve;
            }),
        );
        const disk = fakeAdapter(h, [ARCHIVE]);
        try {
          mgr.driveSelectedOptionals(h.api, COLLECTION);
          await vi.waitFor(() => expect(hashFile).toHaveBeenCalledTimes(1));
          if (change === "cancel") controller.abort();
          else
            h.setState((draft) => {
              draft.persistent.downloads.files["dl-existing"].localPath = "changed.7z";
            });
          release(GOOD_MD5);
          await vi.waitFor(() =>
            expect(
              (mgr as typeof mgr & { mOptionalDownloadsInFlight: Map<string, () => void> })
                .mOptionalDownloadsInFlight.size,
            ).toBe(0),
          );
          expect(tagsOf(h, "dl-existing")).toEqual(["foreign"]);
          expect(h.phaseTracker.get(COLLECTION).pendingByPhase.get(OPTIONAL_PHASE) ?? []).toEqual(
            [],
          );
          expect(disk.starts).toEqual([]);
          expect(
            h.getState().session.collections.activeSession.mods[modRuleId(optional)].status,
          ).toBe(change === "cancel" ? "downloading" : "failed");
        } finally {
          controller.abort();
        }
      },
    );
  }

  imTest(
    "a canceled optional gather cannot block or import into a new operation",
    async ({ makeInstallManager }) => {
      const { h, mgr, optional, controller, dep } = await optionalInstall(makeInstallManager);
      let release!: (deps: unknown[]) => void;
      gather.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      const imported = vi.fn();
      h.api.events.on("import-downloads", imported);
      mgr.driveSelectedOptionals(h.api, COLLECTION);
      controller.abort();
      const nextController = new AbortController();
      const nextOperation = () => nextController.abort();
      mgr.mDependencyInstalls[COLLECTION] = nextOperation;
      mgr.mDependencyAbortSignals.set(nextOperation, nextController.signal);
      h.setState((draft) => {
        draft.session.collections.activeSession.mods[modRuleId(optional)].status = "pending";
      });
      gather.mockResolvedValueOnce([dep]);
      fakeAdapter(h, [ARCHIVE]);
      mgr.driveSelectedOptionals(h.api, COLLECTION);
      await vi.waitFor(() =>
        expect(h.phaseTracker.get(COLLECTION).pendingByPhase.get(OPTIONAL_PHASE)).toHaveLength(1),
      );
      release([{ ...dep, extra: { localPath: "bundle.7z" } }]);
      for (let turn = 0; turn < 12; turn++) await Promise.resolve();
      expect(gather).toHaveBeenCalledTimes(2);
      expect(imported).not.toHaveBeenCalled();
      expect(mgr.mDependencyInstalls[COLLECTION]).toBe(nextOperation);
      expect(h.getState().session.collections.activeSession.mods[modRuleId(optional)].status).toBe(
        "downloaded",
      );
      nextController.abort();
    },
  );

  imTest(
    "queues a bundled exact optional with unknown recorded hash",
    async ({ makeInstallManager }) => {
      const { h, mgr, optional, controller, dep } = await optionalInstall(makeInstallManager);
      gather.mockResolvedValue([{ ...dep, extra: { localPath: "bundle.7z" } }]);
      const imported = vi.fn((_files, callback) => callback(["dl-existing"]));
      h.api.events.on("import-downloads", imported);
      mgr.driveSelectedOptionals(h.api, COLLECTION);
      await vi.waitFor(() =>
        expect(h.phaseTracker.get(COLLECTION).pendingByPhase.get(OPTIONAL_PHASE)).toHaveLength(1),
      );
      expect(imported).toHaveBeenCalledTimes(1);
      expect(h.getState().session.collections.activeSession.mods[modRuleId(optional)].status).toBe(
        "downloaded",
      );
      expect(h.getState().persistent.downloads.files["dl-existing"].fileMD5).toBeUndefined();
      expect(tagsOf(h, "dl-existing")).toEqual(["foreign", TAG]);
      controller.abort();
    },
  );

  imTest(
    "ignores a bundled optional import callback after cancellation",
    async ({ makeInstallManager }) => {
      const { h, mgr, controller, dep } = await optionalInstall(makeInstallManager);
      gather.mockResolvedValue([{ ...dep, extra: { localPath: "bundle.7z" } }]);
      let complete!: (ids: string[]) => void;
      const imported = vi.fn((_files, callback) => {
        complete = callback;
      });
      h.api.events.on("import-downloads", imported);
      mgr.driveSelectedOptionals(h.api, COLLECTION);
      await vi.waitFor(() => expect(imported).toHaveBeenCalledTimes(1));
      controller.abort();
      complete(["dl-existing"]);
      for (let turn = 0; turn < 12; turn++) await Promise.resolve();
      expect(tagsOf(h, "dl-existing")).toEqual(["foreign"]);
      expect(h.phaseTracker.get(COLLECTION).pendingByPhase.get(OPTIONAL_PHASE)).toBeUndefined();
    },
  );
});

describe("settled archive admission", () => {
  imTest(
    "rejects a newly completed size contradiction before event or callback admission",
    async ({ makeInstallManager }) => {
      const { h, queued } = await makeInstall(makeInstallManager, exactRef, onDisk({}));
      const mgr = internals(h.manager);
      mgr.mDependencyInstalls[COLLECTION] = () => undefined;
      const disk = fakeAdapter(h, [], { freshSize: GOOD_SIZE / 2, emitFinished: true });
      await expect(
        mgr.downloadURL(
          h.api,
          { sourceURI: "https://files.example/member.7z", domainName: GAME },
          () => false,
          TAG,
          undefined,
          ARCHIVE,
          undefined,
          exactRef,
        ),
      ).rejects.toThrow("does not match");
      expect(queued).not.toHaveBeenCalled();
      expect(tagsOf(h, "dl-fresh-1")).toEqual([]);
      expect(disk.removed).toEqual([]);
    },
  );

  imTest("leaves an idle selected optional pending", async ({ makeInstallManager }) => {
    const { h, rule } = await makeInstall(makeInstallManager, exactRef, onDisk({}));
    h.setState((draft) => {
      draft.persistent.mods[GAME][COLLECTION].rules = [
        { ...rule, type: "recommends", ignored: false },
      ];
    });
    internals(h.manager).driveSelectedOptionals(h.api, COLLECTION);
    expect(gather).not.toHaveBeenCalled();
    expect(h.getState().session.collections.activeSession.mods[modRuleId(rule)].status).toBe(
      "pending",
    );
  });
});

imTest(
  "an old completion poll stops at a replacement phase and operation",
  async ({ makeInstallManager }) => {
    vi.useFakeTimers();
    try {
      const { h } = await makeInstall(makeInstallManager, exactRef, onDisk({}));
      const mgr = internals(h.manager);
      mgr.mDependencyInstalls[COLLECTION] = () => undefined;
      const checked = vi.spyOn(mgr, "checkCollectionPhaseStatus");
      let settled = false;
      const poll = mgr.pollAllPhasesComplete(h.api, COLLECTION).then(() => {
        settled = true;
      });
      const calls = checked.mock.calls.length;
      h.phaseTracker.delete(COLLECTION);
      const phase = h.phaseTracker.ensure(COLLECTION);
      phase.allowedPhase = 0;
      const replacement = () => undefined;
      mgr.mDependencyInstalls[COLLECTION] = replacement;
      await vi.advanceTimersByTimeAsync(500);
      try {
        expect(settled).toBe(true);
        expect(checked).toHaveBeenCalledTimes(calls);
        expect(h.phaseTracker.get(COLLECTION)).toBe(phase);
        expect(mgr.mDependencyInstalls[COLLECTION]).toBe(replacement);
      } finally {
        delete mgr.mDependencyInstalls[COLLECTION];
        await vi.advanceTimersByTimeAsync(500);
        await poll;
      }
    } finally {
      vi.useRealTimers();
    }
  },
);

imTest(
  "an old scheduled settlement cannot delete a replacement phase promise",
  async ({ makeInstallManager }) => {
    vi.useFakeTimers();
    let replacementPoll: Promise<void> | undefined;
    try {
      const { h } = await makeInstall(makeInstallManager, exactRef, onDisk({}));
      const mgr = internals(h.manager);
      mgr.mDependencyInstalls[COLLECTION] = () => undefined;
      vi.spyOn(mgr, "checkCollectionPhaseStatus").mockReturnValue({
        phaseComplete: false,
        needsRequeue: false,
        allMods: [],
      });
      const old = h.manager.scheduleDeployOnPhaseSettled(h.api, COLLECTION, 0, false)!;
      h.phaseTracker.delete(COLLECTION);
      const phase = h.phaseTracker.ensure(COLLECTION);
      phase.allowedPhase = 0;
      const replacement = () => undefined;
      mgr.mDependencyInstalls[COLLECTION] = replacement;
      replacementPoll = h.manager.scheduleDeployOnPhaseSettled(h.api, COLLECTION, 0, false)!;
      expect(replacementPoll).not.toBe(old);
      await vi.advanceTimersByTimeAsync(500);
      await old;
      try {
        expect(phase.deploymentPromises.get(0)?.deploymentPromise).toBe(replacementPoll);
        expect(mgr.mDependencyInstalls[COLLECTION]).toBe(replacement);
      } finally {
        delete mgr.mDependencyInstalls[COLLECTION];
        await vi.advanceTimersByTimeAsync(500);
        await replacementPoll;
      }
    } finally {
      vi.useRealTimers();
    }
  },
);
for (const failed of [false, true]) {
  imTest(
    "a retired deployment " +
      (failed ? "failure" : "success") +
      " leaves the replacement round untouched",
    async ({ makeInstallManager }) => {
      vi.useFakeTimers();
      try {
        const { h } = await makeInstall(makeInstallManager, exactRef, onDisk({}));
        const mgr = internals(h.manager);
        mgr.mDependencyInstalls[COLLECTION] = () => undefined;
        const oldPhase = h.phaseTracker.get(COLLECTION);
        oldPhase.deploymentPromises.set(0, {
          deploymentPromise: Promise.resolve(),
          deployOnSettle: true,
        });
        vi.spyOn(mgr, "checkCollectionPhaseStatus").mockReturnValue({
          phaseComplete: true,
          needsRequeue: false,
          allMods: [],
        });
        let deployDone!: (error?: Error) => void;
        const deploy = vi.fn((callback) => {
          deployDone = callback;
        });
        h.setState((draft) => {
          draft.settings.downloads.collectionsInstallWhileDownloading = true;
        });
        h.api.events.on("deploy-mods", deploy);
        const oldPoll = h.manager.pollPhaseSettlement(h.api, COLLECTION, { phase: 0 });
        expect(deploy).toHaveBeenCalledTimes(1);
        h.phaseTracker.delete(COLLECTION);
        const phase = h.phaseTracker.ensure(COLLECTION);
        phase.allowedPhase = 0;
        phase.isDeploying = true;
        const pending = vi.fn();
        phase.pendingByPhase.set(0, [pending]);
        const replacement = () => undefined;
        mgr.mDependencyInstalls[COLLECTION] = replacement;
        deployDone(failed ? new Error("old deployment failed") : undefined);
        await vi.advanceTimersByTimeAsync(500);
        await oldPoll;
        expect(pending).not.toHaveBeenCalled();
        expect(oldPhase.deployedPhases.has(0)).toBe(false);
        expect(phase.pendingByPhase.get(0)).toEqual([pending]);
        expect(phase.isDeploying).toBe(true);
        expect(phase.deployedPhases.has(0)).toBe(false);
        expect(mgr.mDependencyInstalls[COLLECTION]).toBe(replacement);
        delete mgr.mDependencyInstalls[COLLECTION];
        await vi.advanceTimersByTimeAsync(500);
      } finally {
        vi.useRealTimers();
      }
    },
  );
}

describe("a rejected archive's retained collection hint", () => {
  for (const mode of ["direct", "browse"] as const) {
    imTest(
      "resolves a " + mode + " hint after real gathering found a stale same-named archive",
      async ({ makeInstallManager }) => {
        const { h, rule, queued } = await makeInstall(
          makeInstallManager,
          exactRef,
          onDisk({ fileMD5: GOOD_MD5, modInfo: { referenceTags: ["foreign", TAG] } }),
        );
        rule.downloadHint = { mode, url: "https://files.example/Member.7z" };
        rule.extra = { name: "Member" };
        const browse = vi.fn().mockResolvedValue(["https://files.example/Member.7z"]);
        Object.assign(h.api, {
          lookupModReference: vi.fn().mockResolvedValue([]),
          lookupModMeta: vi.fn().mockResolvedValue([]),
          emitAndAwait: browse,
        });
        const real = await vi.importActual<typeof Dependencies>("./util/dependencies");
        const deps = await real.default([rule], h.api, false);
        expect(deps[0].download).toBe("dl-existing");
        expect(deps[0].lookupResults).toEqual([]);
        expect(deps[0].downloadHint).toEqual(rule.downloadHint);
        expect(browse).not.toHaveBeenCalled();
        const folder = downloadPathForGame(h.getState(), GAME);
        await mkdir(folder, { recursive: true });
        await writeFile(path.join(folder, ARCHIVE), Buffer.alloc(GOOD_SIZE, 1));
        const disk = fakeAdapter(h, [ARCHIVE]);
        const id = await installMember(h, rule, queued, undefined, deps);
        expect(id).not.toBe("dl-existing");
        expect(disk.starts).toHaveLength(1);
        expect(browse).toHaveBeenCalledTimes(mode === "browse" ? 1 : 0);
        expect(tagsOf(h, "dl-existing")).toEqual(["foreign", TAG]);
        expect(await readFile(path.join(folder, ARCHIVE))).toEqual(Buffer.alloc(GOOD_SIZE, 1));
      },
    );
  }
  imTest(
    "does not resolve an invalid retained hint when actual archive bytes already match",
    async ({ makeInstallManager }) => {
      const { h, rule, queued } = await makeInstall(
        makeInstallManager,
        exactRef,
        onDisk({ fileMD5: GOOD_MD5, modInfo: { referenceTags: ["foreign", TAG] } }),
      );
      rule.downloadHint = { mode: "direct", url: "" };
      Object.assign(h.api, {
        lookupModReference: vi.fn().mockResolvedValue([]),
        lookupModMeta: vi.fn().mockResolvedValue([]),
      });
      const real = await vi.importActual<typeof Dependencies>("./util/dependencies");
      const deps = await real.default([rule], h.api, false);
      expect(deps).toHaveLength(1);
      expect(deps[0].download).toBe("dl-existing");
      const disk = fakeAdapter(h, [ARCHIVE]);
      expect(await installMember(h, rule, queued, undefined, deps)).toBe("dl-existing");
      expect(disk.starts).toEqual([]);
    },
  );
});
