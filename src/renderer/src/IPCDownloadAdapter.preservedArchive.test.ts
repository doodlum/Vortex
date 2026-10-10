import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";

import { beforeEach, expect, vi } from "vitest";

import { downloadPathForGame } from "./extensions/download_management/selectors";
import { test } from "./test-utils/downloadAdapterTest";
import { makeTempDir } from "./test-utils/tempDir";

const reserve = vi.hoisted(() => vi.fn());
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  reserve.mockImplementation(actual.open);
  return { ...actual, default: { ...actual, open: reserve }, open: reserve };
});
const finalize = vi.hoisted(() => vi.fn());
vi.mock("./extensions/download_management/util/preserveExistingDownload", async (original) => {
  const actual =
    await original<
      typeof import("./extensions/download_management/util/preserveExistingDownload")
    >();
  finalize.mockImplementation(actual.preserveExistingDownload);
  return { preserveExistingDownload: finalize };
});
beforeEach(async () => {
  const disk = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  reserve.mockReset().mockImplementation(disk.open);
  const actual = await vi.importActual<
    typeof import("./extensions/download_management/util/preserveExistingDownload")
  >("./extensions/download_management/util/preserveExistingDownload");
  finalize.mockReset().mockImplementation(actual.preserveExistingDownload);
});

for (const redownload of ["always", undefined, "never", "ask", "replace"] as const) {
  test(
    redownload === "always"
      ? "a forced collection download preserves the same-named archive and hashes the new bytes"
      : "server-named completion with no hint respects " + String(redownload),
    async ({ makeDownloadAdapter }) => {
      const root = await makeTempDir("adapter-preserved-");
      const h = makeDownloadAdapter({ download: { localPath: "member.zip", state: "finished" } });
      h.setState((draft) => {
        draft.settings.downloads.path = root;
      });
      const folder = downloadPathForGame(h.getState(), "skyrimse");
      await mkdir(folder, { recursive: true });
      const old = path.join(folder, "member.zip");
      await writeFile(old, "other collection bytes");
      Object.assign(window.api, {
        hash: {
          compute: vi.fn(async (_algorithm: string, filePath: string) => {
            const bytes = await readFile(filePath);
            return { hash: createHash("md5").update(bytes).digest("hex"), numBytes: bytes.length };
          }),
        },
      });
      const completed = new Promise<{ error: Error | null; id: string }>((resolve) => {
        h.events.emit(
          "start-download",
          ["https://cdn.example/member.zip"],
          { game: "skyrimse", referenceTag: "new-rule" },
          redownload === "always" || redownload === "replace" ? "member.zip" : undefined,
          (error: Error | null, id: string) => resolve({ error, id }),
          redownload,
          { allowInstall: false },
        );
      });
      await h.started.promise;
      const [temp] = h.start.mock.calls[0] as [string];
      await writeFile(temp, "new collection bytes");
      const id = "new-0";
      h.getStates.mockResolvedValue({
        [id]: {
          status: "completed",
          error: null,
          bytesReceived: 20,
          bytesWritten: 20,
          size: 20,
          fileName: "member.zip",
          isChunked: false,
        },
      });
      await vi.advanceTimersByTimeAsync(250);
      const result = await completed;
      expect(result.error).toBeNull();
      const download = h.getState().persistent.downloads.files[result.id];
      expect(download.modInfo.allowInstall).toBe(false);
      expect(download.localPath === "member.zip").toBe(redownload === "replace");
      expect(await readFile(old, "utf8")).toBe(
        redownload === "replace" ? "new collection bytes" : "other collection bytes",
      );
      expect(await readFile(path.join(folder, download.localPath), "utf8")).toBe(
        "new collection bytes",
      );
      expect(download.fileMD5).toBe(createHash("md5").update("new collection bytes").digest("hex"));
      expect(h.getState().persistent.downloads.files[h.downloadId].localPath).toBe("member.zip");
    },
  );
}

test("a hydrated forced download preserves the archive and collection install ownership", async ({
  makeDownloadAdapter,
}) => {
  const root = await makeTempDir("adapter-preserved-hydrated-");
  const h = makeDownloadAdapter({
    download: {
      state: "started",
      localPath: "__vortex_tmp_42",
      modInfo: { preserveExistingArchive: true, allowInstall: false },
    },
    automationInstall: true,
    checkpoint: {
      downloadId: "dl-0",
      resource: "https://cdn.example/member.zip",
      dest: "unused",
      etag: undefined,
      completedRanges: [{ start: 0, end: 10 }],
    },
  });
  h.setState((draft) => {
    draft.settings.downloads.path = root;
  });
  const folder = downloadPathForGame(h.getState(), "skyrimse");
  await mkdir(folder, { recursive: true });
  const old = path.join(folder, "member.zip");
  await writeFile(old, "old bytes");
  await writeFile(path.join(folder, "__vortex_tmp_42"), "new bytes");
  Object.assign(window.api, {
    hash: {
      compute: vi.fn(async (_algorithm, filePath) => {
        const bytes = await readFile(filePath);
        return { hash: createHash("md5").update(bytes).digest("hex"), numBytes: bytes.length };
      }),
    },
  });
  const install = vi.fn();
  h.events.on("start-install-download", install);
  h.adapter.hydrateFromState();
  expect(h.resume).toHaveBeenCalledTimes(1);
  h.getStates.mockResolvedValue({
    [h.downloadId]: {
      status: "completed",
      error: null,
      bytesReceived: 9,
      bytesWritten: 9,
      size: 9,
      fileName: "member.zip",
      isChunked: false,
    },
  });
  await vi.advanceTimersByTimeAsync(250);
  await vi.waitFor(() =>
    expect(h.getState().persistent.downloads.files[h.downloadId].state).toBe("finished"),
  );
  const download = h.getState().persistent.downloads.files[h.downloadId];
  expect(download.localPath).not.toBe("member.zip");
  expect(install).not.toHaveBeenCalled();
  expect(download.fileMD5).toBe(createHash("md5").update("new bytes").digest("hex"));
  expect(await readFile(old, "utf8")).toBe("old bytes");
  expect(await readFile(path.join(folder, download.localPath), "utf8")).toBe("new bytes");
});

test("failed finalization keeps the temp record and hashes its bytes", async ({
  makeDownloadAdapter,
}) => {
  const root = await makeTempDir("adapter-preserved-error-");
  const h = makeDownloadAdapter({ download: { localPath: "member.zip", state: "finished" } });
  h.setState((draft) => {
    draft.settings.downloads.path = root;
  });
  const folder = downloadPathForGame(h.getState(), "skyrimse");
  await mkdir(folder, { recursive: true });
  const old = path.join(folder, "member.zip");
  await writeFile(old, "old bytes");
  finalize.mockRejectedValue(Object.assign(new Error("denied"), { code: "EACCES" }));
  Object.assign(window.api, {
    hash: {
      compute: vi.fn(async (_algorithm, filePath) => {
        const bytes = await readFile(filePath);
        return { hash: createHash("md5").update(bytes).digest("hex"), numBytes: bytes.length };
      }),
    },
  });
  const completed = new Promise<{ error: Error | null; id: string }>((resolve) => {
    h.events.emit(
      "start-download",
      ["https://cdn.example/member.zip"],
      { game: "skyrimse" },
      "member.zip",
      (error, id) => resolve({ error, id }),
      "always",
      { allowInstall: false },
    );
  });
  await h.started.promise;
  const [temp] = h.start.mock.calls[0] as [string];
  await writeFile(temp, "new bytes");
  h.getStates.mockResolvedValue({
    "new-0": {
      status: "completed",
      error: null,
      bytesReceived: 9,
      bytesWritten: 9,
      size: 9,
      fileName: "member.zip",
      isChunked: false,
    },
  });
  await vi.advanceTimersByTimeAsync(250);
  const result = await completed;
  const download = h.getState().persistent.downloads.files[result.id];
  expect(result.error).toBeNull();
  expect(download.localPath).toBe(path.basename(temp));
  expect(download.fileMD5).toBe(createHash("md5").update("new bytes").digest("hex"));
  expect(await readFile(old, "utf8")).toBe("old bytes");
  expect(await readFile(temp, "utf8")).toBe("new bytes");
});

for (const override of ["force", true] as const) {
  test(
    "explicit resume " + override + " replaces a hydrated collection install opt-out",
    async ({ makeDownloadAdapter }) => {
      const root = await makeTempDir("adapter-install-override-");
      const h = makeDownloadAdapter({
        download: { state: "started", localPath: "member.zip", modInfo: { allowInstall: false } },
        automationInstall: override === true,
        checkpoint: {
          downloadId: "dl-0",
          resource: "https://cdn.example/member.zip",
          dest: "unused",
          etag: undefined,
          completedRanges: [{ start: 0, end: 10 }],
        },
      });
      h.setState((draft) => {
        draft.settings.downloads.path = root;
      });
      const folder = downloadPathForGame(h.getState(), "skyrimse");
      await mkdir(folder, { recursive: true });
      await writeFile(path.join(folder, "member.zip"), "new bytes");
      Object.assign(window.api, {
        hash: {
          compute: vi.fn(async (_algorithm, filePath) => {
            const bytes = await readFile(filePath);
            return { hash: createHash("md5").update(bytes).digest("hex"), numBytes: bytes.length };
          }),
        },
      });
      const install = vi.fn();
      h.events.on("start-install-download", install);
      h.adapter.hydrateFromState();
      await new Promise<void>((resolve) =>
        h.events.emit("resume-download", h.downloadId, () => resolve(), { allowInstall: override }),
      );
      expect(h.getState().persistent.downloads.files[h.downloadId].modInfo.allowInstall).toBe(
        override === "force" ? true : undefined,
      );
      h.getStates.mockResolvedValue({
        [h.downloadId]: {
          status: "completed",
          error: null,
          bytesReceived: 9,
          bytesWritten: 9,
          size: 9,
          fileName: "member.zip",
          isChunked: false,
        },
      });
      await vi.advanceTimersByTimeAsync(250);
      await vi.waitFor(() => expect(install).toHaveBeenCalledTimes(1));
    },
  );
}

for (const state of ["paused", "finished"] as const) {
  test(
    "a new post-restart transfer preserves an older " + state + " temporary archive",
    async ({ makeDownloadAdapter }) => {
      const root = await makeTempDir("adapter-old-temp-");
      const h = makeDownloadAdapter({
        download: {
          state,
          localPath: "__vortex_tmp_00000000",
          modInfo: { referenceTag: "foreign-rule" },
        },
      });
      h.setState((draft) => {
        draft.settings.downloads.path = root;
      });
      const folder = downloadPathForGame(h.getState(), "skyrimse");
      await mkdir(folder, { recursive: true });
      const old = path.join(folder, "__vortex_tmp_00000000");
      await writeFile(old, "previous transfer bytes");
      const previous = structuredClone(h.getState().persistent.downloads.files[h.downloadId]);
      const start = h.start.getMockImplementation()!;
      h.start.mockImplementation(async (...args) => {
        await writeFile(args[0], "new transfer bytes");
        return start(...args);
      });
      h.events.emit(
        "start-download",
        ["https://cdn.example/new.zip"],
        { game: "skyrimse" },
        undefined,
        () => undefined,
        "always",
        { allowInstall: false },
      );
      await h.started.promise;
      const [dest] = h.start.mock.calls[0] as [string];
      expect(dest).not.toBe(old);
      expect(await readFile(old, "utf8")).toBe("previous transfer bytes");
      expect(await readFile(dest, "utf8")).toBe("new transfer bytes");
      expect(h.getState().persistent.downloads.files[h.downloadId]).toEqual(previous);
    },
  );
}
test("a reserved UUID collision refuses the new transfer without overwriting existing bytes", async ({
  makeDownloadAdapter,
}) => {
  const root = await makeTempDir("adapter-reservation-collision-");
  const h = makeDownloadAdapter({ download: { state: "finished", localPath: "member.zip" } });
  h.setState((draft) => {
    draft.settings.downloads.path = root;
  });
  const folder = downloadPathForGame(h.getState(), "skyrimse");
  await mkdir(folder, { recursive: true });
  const disk = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  let existing = "";
  reserve.mockImplementationOnce(async (filePath, flags) => {
    existing = String(filePath);
    await disk.writeFile(existing, "previous bytes");
    return disk.open(filePath, flags);
  });
  const callback = vi.fn();
  h.events.emit(
    "start-download",
    ["https://cdn.example/new.zip"],
    { game: "skyrimse" },
    undefined,
    callback,
    "always",
  );
  await vi.waitFor(() => expect(reserve).toHaveBeenCalled());
  await vi.waitFor(() =>
    expect(callback.mock.calls.length + h.start.mock.calls.length).toBeGreaterThan(0),
  );
  expect(h.start).not.toHaveBeenCalled();
  expect(callback).toHaveBeenCalled();
  expect(callback.mock.calls[0][0]).toMatchObject({ code: "EEXIST" });
  expect(await readFile(existing, "utf8")).toBe("previous bytes");
});

test("a rejected downloader start removes only its newly reserved temporary file", async ({
  makeDownloadAdapter,
}) => {
  const root = await makeTempDir("adapter-reservation-start-error-");
  const h = makeDownloadAdapter({ download: { state: "finished", localPath: "member.zip" } });
  h.setState((draft) => {
    draft.settings.downloads.path = root;
  });
  const folder = downloadPathForGame(h.getState(), "skyrimse");
  await mkdir(folder, { recursive: true });
  const existing = path.join(folder, "member.zip");
  await writeFile(existing, "previous bytes");
  h.start.mockRejectedValueOnce(new Error("cannot start"));
  const result = await new Promise<{ error: Error | null }>((resolve) =>
    h.events.emit(
      "start-download",
      ["https://cdn.example/new.zip"],
      { game: "skyrimse" },
      undefined,
      (error) => resolve({ error }),
      "always",
    ),
  );
  expect(result.error?.message).toBe("cannot start");
  const [dest] = h.start.mock.calls[0] as [string];
  await expect(readFile(dest)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(existing, "utf8")).toBe("previous bytes");
});
