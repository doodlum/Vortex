/**
 * LAZ-1287: how an extraction failure reported by 7z is classified. The first three error strings
 * are 7-Zip 26.00's (the bundled 7z-bin) as node-7z collects them from real runs: a truncated .7z,
 * a zero-filled .zip and an archive another process holds open with an exclusive lock. The
 * localised one stands in for that lock on a non-English Windows, where 7z's own text stays English
 * and only the system message is translated.
 */
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, vi } from "vitest";

import type { IInstallManagerHarness } from "../../test-utils/harnessTypes";
import { test as imTest } from "../../test-utils/installManagerTest";
import { ArchiveBrokenError } from "../../util/CustomErrors";

vi.mock("../../util/log", () => {
  const log = vi.fn();
  return { default: log, log };
});

const ARCHIVE = "C:\\Users\\someone\\Downloads\\Skyland AIO-4.32.0.7z";

const TRUNCATED_7Z =
  `ERROR: ${ARCHIVE}\r\n${ARCHIVE}\r\nOpen ERROR: Cannot open the file as [7z] archive\r\n` +
  "\r\n\r\nERRORS:\r\nUnexpected end of archive\r\n";
const NOT_AN_ARCHIVE =
  `ERROR: ${ARCHIVE}\r\n${ARCHIVE}\r\nOpen ERROR: Cannot open the file as [zip] archive\r\n` +
  "\r\n\r\nERRORS:\r\nIs not archive\r\n";
const LOCKED =
  `ERROR: ${ARCHIVE}\r\nCannot open the file as archive\r\n\r\n` +
  "The process cannot access the file because it is being used by another process.\r\n";
const LOCKED_LOCALISED =
  `ERROR: ${ARCHIVE}\r\nCannot open the file as archive\r\n\r\n` +
  "Der Prozess kann nicht auf die Datei zugreifen, da sie von einem anderen Prozess verwendet " +
  "wird.\r\n";

interface IExtractResult {
  code: number;
  errors: string[];
}

/** The private members on the extraction path, reached through one cast. */
interface IExtractionInternals {
  installInner(
    api: unknown,
    archivePath: string,
    tempPath: string,
    destinationPath: string,
    gameId: string,
    installContext: undefined,
    installationZip: unknown,
  ): Promise<unknown>;
  extractWithRetry(
    zip: unknown,
    archivePath: string,
    tempPath: string,
    progress: () => void,
    queryPassword: () => PromiseLike<string>,
    maxRetries?: number,
    retryDelayMs?: number,
  ): Promise<IExtractResult>;
  queryContinue(api: unknown, errors: string[], archivePath: string): Promise<void>;
}

/** A 7z stand-in whose every run exits 2 with the given errors, as node-7z resolves it. */
function failingZip(errors: string[]) {
  return { extractFull: vi.fn(() => Promise.resolve({ code: 2, errors })) };
}

function tempDir(): string {
  return path.join(os.tmpdir(), `vortex-laz1287-${process.pid}-${Math.random().toString(36)}`);
}

/** Labels of the "Archive damaged" dialog's buttons, or undefined while none was shown. */
function damagedDialogActions(h: IInstallManagerHarness): string[] | undefined {
  const dialog = h.dispatched.find((action) => action.type === "SHOW_MODAL_DIALOG");
  return (dialog?.payload as { actions: string[] } | undefined)?.actions;
}

/** Settles with the install's outcome, or with "dialog" once the dialog is up (it never settles). */
async function outcomeOf(h: IInstallManagerHarness, install: Promise<unknown>): Promise<unknown> {
  const dialogShown = vi
    .waitFor(
      () => {
        if (damagedDialogActions(h) === undefined) {
          throw new Error("no dialog yet");
        }
      },
      { timeout: 8000, interval: 20 },
    )
    .then(() => "dialog");
  return Promise.race([
    install.then(
      () => "installed",
      (err: unknown) => err,
    ),
    dialogShown,
  ]);
}

describe("InstallManager extraction errors", () => {
  imTest(
    "a truncated .7z fails as a damaged archive at once, without retries or the dialog",
    { timeout: 15000 },
    async ({ makeInstallManager }) => {
      const h = makeInstallManager();
      const internals = h.manager as unknown as IExtractionInternals;
      const zip = failingZip([TRUNCATED_7Z]);

      const install = internals.installInner(
        h.api,
        ARCHIVE,
        tempDir(),
        tempDir(),
        "skyrimse",
        undefined,
        zip,
      );

      const outcome = await outcomeOf(h, install);
      expect(outcome).toBeInstanceOf(ArchiveBrokenError);
      expect(zip.extractFull).toHaveBeenCalledTimes(1);
      expect(damagedDialogActions(h)).toBeUndefined();
    },
  );

  imTest(
    "a file 7z recognises but can't open is asked about once, without Continue",
    { timeout: 15000 },
    async ({ makeInstallManager }) => {
      const h = makeInstallManager();
      const internals = h.manager as unknown as IExtractionInternals;
      const zip = failingZip([NOT_AN_ARCHIVE]);

      const install = internals.installInner(
        h.api,
        ARCHIVE,
        tempDir(),
        tempDir(),
        "skyrimse",
        undefined,
        zip,
      );

      expect(await outcomeOf(h, install)).toBe("dialog");
      expect(zip.extractFull).toHaveBeenCalledTimes(1);
      expect(damagedDialogActions(h)).toEqual(["Cancel", "Delete"]);
    },
  );

  imTest.for([
    ["in English", LOCKED],
    ["on a non-English Windows", LOCKED_LOCALISED],
  ])(
    "an archive another process holds is retried %s",
    async ([, error], { makeInstallManager }) => {
      const h = makeInstallManager();
      const internals = h.manager as unknown as IExtractionInternals;
      const zip = failingZip([error]);

      const result = await internals.extractWithRetry(
        zip,
        ARCHIVE,
        tempDir(),
        () => undefined,
        () => Promise.resolve(""),
        3,
        0,
      );

      expect(zip.extractFull).toHaveBeenCalledTimes(4);
      expect(result.code).toBe(2);
    },
  );

  imTest(
    "an archive still held after the retries is not offered Continue",
    async ({ makeInstallManager }) => {
      const h = makeInstallManager();
      const internals = h.manager as unknown as IExtractionInternals;

      void internals.queryContinue(h.api, [LOCKED], ARCHIVE);

      expect(damagedDialogActions(h)).toEqual(["Cancel", "Delete"]);
    },
  );

  imTest(
    "an archive that extracted with errors is still offered Continue",
    async ({ makeInstallManager }) => {
      const h = makeInstallManager();
      const internals = h.manager as unknown as IExtractionInternals;

      void internals.queryContinue(h.api, ["ERROR: CRC Failed : data.bin\r\n"], ARCHIVE);

      expect(damagedDialogActions(h)).toEqual(["Cancel", "Delete", "Continue"]);
    },
  );
});
