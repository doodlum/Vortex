/**
 * A collection member whose archive name is already taken in the download folder (LAZ-1286).
 *
 * The download adapter reuses an on-disk file by name alone. For a member that pins one exact file
 * (a non-fuzzy version with a file hash) a same-named file with another hash, such as a truncated
 * copy, must not be reused or tagged as the member, or every retry installs the same bad file. A
 * same-named copy that is the right file must still be reused without a download (LAZ-972).
 */
import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";

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
import type { IModReference } from "./types/IMod";
import { downloadReferenceTags } from "./util/testModReference";

vi.mock("../../logging", () => ({ log: vi.fn() }));

const hashFile = vi.hoisted(() => vi.fn<(filePath: string) => Promise<string>>());
vi.mock("../../util/checksum", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fileMD5: hashFile,
}));

beforeEach(() => {
  hashFile.mockReset();
});

const GAME = "skyrimse";
const PROFILE = "prof-1";
const COLLECTION = "col-1";
const ARCHIVE = "Member-100-1-0.7z";
const GOOD_MD5 = "good-md5";
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
function fakeAdapter(h: IInstallManagerHarness, onDisk: string[]): IFakeDisk {
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
      const files = h.getState().persistent.downloads.files;
      const existing = Object.keys(files).find((id) => files[id].localPath === fileName);
      if (redownload !== "replace" && disk.files.has(fileName) && existing !== undefined) {
        callback(new AlreadyDownloaded(fileName, existing));
        return;
      }
      const id = `dl-fresh-${disk.starts.length}`;
      h.setState((draft) => {
        draft.persistent.downloads.files[id] = makeDownload({
          id,
          state: "finished",
          game: [GAME],
          localPath: fileName,
          size: GOOD_SIZE,
          fileMD5: GOOD_MD5,
        });
      });
      disk.files.add(fileName);
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

function makeInstall(
  makeInstallManager: (overrides?: object) => IInstallManagerHarness,
  reference: IModReference,
  existing: IDownload,
) {
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
): Promise<string> {
  const installing = internals(h.manager).doInstallDependencies(
    h.api,
    GAME,
    COLLECTION,
    [
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
    await vi.waitFor(() => expect(queued.mock.calls.length).toBeGreaterThan(0));
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
      const { h, rule, queued } = makeInstall(
        makeInstallManager,
        exactRef,
        onDisk({ fileMD5: "truncated-md5", size: GOOD_SIZE / 2 }),
      );
      const disk = fakeAdapter(h, [ARCHIVE]);

      const installed = await installMember(h, rule, queued);

      expect(installed).not.toBe("dl-existing");
      expect(h.getState().persistent.downloads.files[installed].fileMD5).toBe(GOOD_MD5);
      expect(tagsOf(h, installed)).toEqual([TAG]);
      // the bad copy is gone, so no later lookup can resolve the member to it
      expect(disk.removed).toEqual(["dl-existing"]);
      expect(h.getState().persistent.downloads.files["dl-existing"]).toBeUndefined();
      expect(hashFile).not.toHaveBeenCalled();
    },
  );

  imTest(
    "is re-downloaded without hashing when its size isn't the member's",
    async ({ makeInstallManager }) => {
      // adopted by name from the folder, so no hash is recorded yet
      const { h, rule, queued } = makeInstall(
        makeInstallManager,
        exactRef,
        onDisk({ size: GOOD_SIZE / 2 }),
      );
      const disk = fakeAdapter(h, [ARCHIVE]);

      const installed = await installMember(h, rule, queued);

      expect(installed).not.toBe("dl-existing");
      expect(disk.removed).toEqual(["dl-existing"]);
      expect(hashFile).not.toHaveBeenCalled();
    },
  );

  imTest(
    "is hashed when nothing is recorded, and re-downloaded on a mismatch",
    async ({ makeInstallManager }) => {
      hashFile.mockResolvedValue("other-md5");
      const { h, rule, queued } = makeInstall(makeInstallManager, exactRef, onDisk({}));
      const disk = fakeAdapter(h, [ARCHIVE]);

      const installed = await installMember(h, rule, queued);

      expect(hashFile).toHaveBeenCalledTimes(1);
      expect(installed).not.toBe("dl-existing");
      expect(disk.removed).toEqual(["dl-existing"]);
    },
  );

  // LAZ-972: an archive another collection (or an earlier install) fetched is reused as it is
  imTest(
    "is reused and tagged, without a download, when it is the member's file",
    async ({ makeInstallManager }) => {
      const { h, rule, queued } = makeInstall(
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
      const { h, rule, queued } = makeInstall(makeInstallManager, exactRef, onDisk({}));
      const disk = fakeAdapter(h, [ARCHIVE]);

      const installed = await installMember(h, rule, queued);

      expect(installed).toBe("dl-existing");
      expect(disk.removed).toEqual([]);
      // the hash is recorded, so the next lookup doesn't hash again
      expect(h.getState().persistent.downloads.files["dl-existing"].fileMD5).toBe(GOOD_MD5);
    },
  );

  // a fuzzy version resolves to files with other hashes by design, so the hash isn't checked
  imTest("is reused for a fuzzy member whatever its hash", async ({ makeInstallManager }) => {
    const fuzzyRef = makeFuzzyRef({ tag: TAG, gameId: GAME, fileMD5: GOOD_MD5 });
    const { h, rule, queued } = makeInstall(
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
      const { h, rule, queued } = makeInstall(
        makeInstallManager,
        exactRef,
        onDisk({ fileMD5: "truncated-md5", modInfo: { referenceTag: TAG, referenceTags: [TAG] } }),
      );
      const disk = fakeAdapter(h, [ARCHIVE]);

      const installed = await installMember(h, rule, queued, "dl-existing");

      expect(installed).not.toBe("dl-existing");
      expect(h.getState().persistent.downloads.files[installed].fileMD5).toBe(GOOD_MD5);
      expect(disk.removed).toEqual(["dl-existing"]);
    },
  );
});

describe("an archive whose record no longer describes the file", () => {
  // the hash was recorded when the download finished; the file was cut short afterwards
  imTest(
    "is re-downloaded when its size on disk isn't the member's",
    async ({ makeInstallManager }) => {
      const { h, rule, queued } = makeInstall(
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
      expect(disk.removed).toEqual(["dl-existing"]);
      expect(hashFile).not.toHaveBeenCalled();
    },
  );

  // an earlier attempt installed the bad copy, which marked the download failed; the adapter still
  // hands it back by name
  imTest("is re-downloaded after it failed to install", async ({ makeInstallManager }) => {
    const { h, rule, queued } = makeInstall(
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
    expect(disk.removed).toEqual(["dl-existing"]);
  });
});
