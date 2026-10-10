import { expect, vi } from "vitest";

import { setDownloadHash } from "./extensions/download_management/actions/state";
import { test, type IDownloadAdapterFixtures } from "./test-utils/downloadAdapterTest";

vi.mock("./util/getVortexPath", () => ({ default: () => "/vortex-userdata" }));

// The main process hashes a download while writing it and reports the MD5 with the completed
// state. The adapter then records it without reading the file again; without one it hashes the
// file as before.
async function complete(
  makeDownloadAdapter: IDownloadAdapterFixtures["makeDownloadAdapter"],
  md5: string | undefined,
) {
  const h = makeDownloadAdapter({ download: { state: "paused" } });
  const compute = vi.fn().mockResolvedValue({ hash: "hash-from-file", numBytes: 100 });
  (window.api as unknown as { hash: unknown }).hash = { compute };
  const finished = new Promise<void>((resolve) =>
    h.events.on("did-finish-download", () => resolve()),
  );
  h.events.emit("resume-download", h.downloadId, () => undefined);
  await h.started.promise;
  h.getStates.mockResolvedValue({
    [h.downloadId]: {
      status: "completed",
      error: null,
      bytesReceived: 100,
      bytesWritten: 100,
      size: 100,
      fileName: undefined,
      isChunked: false,
      ...(md5 !== undefined ? { md5 } : {}),
    },
  });
  await vi.advanceTimersByTimeAsync(250);
  await finished;
  return { h, compute };
}

test("records the MD5 hashed while downloading without reading the file", async ({
  makeDownloadAdapter,
}) => {
  const { h, compute } = await complete(makeDownloadAdapter, "hash-while-downloading");
  expect(compute).not.toHaveBeenCalled();
  expect(h.dispatched).toContainEqual(setDownloadHash(h.downloadId, "hash-while-downloading"));
});

test("negative control: hashes the file when the download reported no MD5", async ({
  makeDownloadAdapter,
}) => {
  const { h, compute } = await complete(makeDownloadAdapter, undefined);
  expect(compute).toHaveBeenCalledWith("md5", expect.stringContaining("file.bin"));
  expect(h.dispatched).toContainEqual(setDownloadHash(h.downloadId, "hash-from-file"));
});
