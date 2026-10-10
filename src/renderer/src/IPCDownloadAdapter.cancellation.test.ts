import { UserCanceled } from "@vortex/shared/errors";
import type { WireDownloadCheckpoint } from "@vortex/shared/ipc";
import { describe, expect, vi } from "vitest";

import { finishDownload, pauseDownload } from "./extensions/download_management/actions/state";
import { NxmProtocol } from "./extensions/nexus_integration/nxmProtocol";
import { makeNxmHarness, makeUserInfo } from "./test-utils/builders";
import { test } from "./test-utils/downloadAdapterTest";

vi.mock("./util/getVortexPath", () => ({ default: () => "/vortex-userdata" }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
const resolveDownload = () => vi.mocked(window.api.downloader.onResolve).mock.calls[0]![0];
const result = { urls: ["https://cdn.example/file"], meta: {} };
const checkpoint = (downloadId: string): WireDownloadCheckpoint => ({
  downloadId,
  dest: "unused",
  resource: "https://cdn.example/file",
  completedRanges: [],
  etag: undefined,
});

describe("pending download cancellation", () => {
  test("pause settles restore cleanup before its callback immediately resumes again", async ({
    makeDownloadAdapter,
  }) => {
    const h = makeDownloadAdapter({ download: { state: "paused" } });
    const handoff = deferred<void>();
    const id = deferred<{ downloadId: string }>();
    h.start.mockImplementationOnce(async (_dest: string, collationId: number) => {
      await resolveDownload()(collationId);
      handoff.resolve();
      return id.promise;
    });
    vi.mocked(window.api.downloader.pause).mockResolvedValue(checkpoint(h.downloadId));
    const first = deferred<Error | null>();
    const second = vi.fn();
    const paused = vi.fn((error: Error | null) => {
      expect(error).toBeNull();
      h.events.emit("resume-download", h.downloadId, second);
    });
    h.events.emit("resume-download", h.downloadId, first.resolve);
    await handoff.promise;
    h.events.emit("pause-download", h.downloadId, paused);
    try {
      await Promise.resolve();
      expect(paused).not.toHaveBeenCalled();
    } finally {
      id.resolve({ downloadId: h.downloadId });
      await first.promise;
    }
    expect(await first.promise).toBeInstanceOf(UserCanceled);
    await vi.waitFor(() => expect(h.start).toHaveBeenCalledTimes(2));
    expect(paused).toHaveBeenCalledTimes(1);
    h.getStates.mockResolvedValue({
      [h.downloadId]: { status: "completed", bytesReceived: 0, bytesWritten: 0, size: 0 },
    });
    await vi.advanceTimersByTimeAsync(200);
    await vi.waitFor(() => expect(second).toHaveBeenCalledTimes(1));
    expect(second).toHaveBeenCalledWith(null, h.downloadId);
  });

  test("a collection intercept stops a timed-out GET before retry and transfer handoff", async ({
    makeDownloadAdapter,
  }) => {
    const h = makeDownloadAdapter();
    const nexus = makeNxmHarness();
    h.setState((draft) => {
      draft.persistent["nexus"] = { userInfo: makeUserInfo() };
      draft.session["gameMode"] = nexus.getState().session["gameMode"];
    });
    const nxm = new NxmProtocol(h.api, () => nexus.nexus);
    nexus.getDownloadURLs
      .mockRejectedValueOnce(Object.assign(new Error("connect timed out"), { code: "ETIMEDOUT" }))
      .mockResolvedValue([{ URI: "https://cdn.example/late" }]);
    h.adapter.registerProtocol("nxm", nxm.resolve);
    const cancelled = deferred<Error | null>();
    h.events.emit(
      "start-download",
      ["nxm://skyrimspecialedition/mods/123/files/456"],
      { game: "skyrimse", referenceTag: "member-A" },
      undefined,
      cancelled.resolve,
      "always",
    );
    await vi.waitFor(() => expect(nexus.getDownloadURLs).toHaveBeenCalledTimes(1));
    h.events.emit("intercept-download", "member-A");
    await vi.advanceTimersByTimeAsync(5000);
    expect(nexus.getDownloadURLs).toHaveBeenCalledTimes(1);
    expect(await cancelled.promise).toBeInstanceOf(UserCanceled);
    expect(h.dispatched.some((action) => action.type === "INIT_DOWNLOAD")).toBe(false);
  });

  test("only a matching defined reference tag cancels resolution, including a handler that ignores signals", async ({
    makeDownloadAdapter,
  }) => {
    const h = makeDownloadAdapter();
    const a = deferred<typeof result>();
    const b = deferred<typeof result>();
    const handler = vi.fn(
      (url: string, _name?: string, _friendlyName?: string, _signal?: AbortSignal) => {
        return url.includes("/123/") ? a.promise : b.promise;
      },
    );
    h.adapter.registerProtocol("nxm", handler);
    const cancelled = deferred<Error | null>();
    h.events.emit(
      "start-download",
      ["nxm://skyrimse/mods/123/files/456"],
      { game: "skyrimse", referenceTag: "A" },
      undefined,
      cancelled.resolve,
      "always",
    );
    h.events.emit(
      "start-download",
      ["nxm://skyrimse/mods/124/files/456"],
      { game: "skyrimse", referenceTag: "B" },
      undefined,
      undefined,
      "always",
    );
    await vi.waitFor(() =>
      expect(handler.mock.calls.map(([url]) => url)).toEqual(
        expect.arrayContaining([
          "nxm://skyrimse/mods/123/files/456",
          "nxm://skyrimse/mods/124/files/456",
        ]),
      ),
    );
    h.events.emit("intercept-download", undefined);
    h.events.emit("intercept-download", "");
    h.events.emit("intercept-download", "unrelated");
    expect(handler.mock.calls.map(([url]) => url)).toEqual(
      expect.arrayContaining([
        "nxm://skyrimse/mods/123/files/456",
        "nxm://skyrimse/mods/124/files/456",
      ]),
    );
    const aSignal = handler.mock.calls.find(([url]) => url.includes("/123/"))![3] as AbortSignal;
    const bSignal = handler.mock.calls.find(([url]) => url.includes("/124/"))![3] as AbortSignal;
    expect(aSignal.aborted).toBe(false);
    expect(bSignal.aborted).toBe(false);
    h.events.emit("intercept-download", "A");
    expect(await cancelled.promise).toBeInstanceOf(UserCanceled);
    expect(aSignal.aborted).toBe(true);
    expect(bSignal.aborted).toBe(false);
    a.resolve(result);
    b.resolve(result);
    await h.started.promise;
    await vi.advanceTimersByTimeAsync(0);
    const initialised = h.dispatched.filter((action) => action.type === "INIT_DOWNLOAD");
    expect(initialised).toHaveLength(1);
  });

  test("an intercept after resolution but before IPC start returns stops the late handle", async ({
    makeDownloadAdapter,
  }) => {
    const h = makeDownloadAdapter();
    h.adapter.registerProtocol("nxm", vi.fn().mockResolvedValue(result));
    const handoff = deferred<void>();
    const id = deferred<{ downloadId: string }>();
    h.start.mockImplementation(async (_dest: string, collationId: number) => {
      await resolveDownload()(collationId);
      handoff.resolve();
      return id.promise;
    });
    vi.mocked(window.api.downloader.pause).mockResolvedValue(checkpoint("late"));
    const cancelled = deferred<Error | null>();
    h.events.emit(
      "start-download",
      ["nxm://skyrimse/mods/123/files/456"],
      { game: "skyrimse", referenceTag: "A" },
      undefined,
      cancelled.resolve,
      "always",
    );
    await handoff.promise;
    h.events.emit("intercept-download", "A");
    id.resolve({ downloadId: "late" });
    expect(await cancelled.promise).toBeInstanceOf(UserCanceled);
    expect(window.api.downloader.pause).toHaveBeenCalledWith("late");
    expect(h.dispatched.some((action) => action.type === "INIT_DOWNLOAD")).toBe(false);
  });

  test("intercepts preparation before a resolver or main-process start exists", async ({
    makeDownloadAdapter,
  }) => {
    const h = makeDownloadAdapter();
    const cancelled = deferred<Error | null>();
    h.events.emit(
      "start-download",
      ["https://cdn.example/file"],
      { game: "skyrimse", referenceTag: "A" },
      undefined,
      cancelled.resolve,
      "always",
    );
    h.events.emit("intercept-download", "A");
    expect(await cancelled.promise).toBeInstanceOf(UserCanceled);
    expect(h.start).not.toHaveBeenCalled();
  });

  test("remove during a restore's handoff stops its late handle before deleting the record", async ({
    makeDownloadAdapter,
  }) => {
    const h = makeDownloadAdapter({ download: { state: "paused" } });
    const handoff = deferred<void>();
    const id = deferred<{ downloadId: string }>();
    h.start.mockImplementation(async (_dest: string, collationId: number) => {
      await resolveDownload()(collationId);
      handoff.resolve();
      return id.promise;
    });
    vi.mocked(window.api.downloader.pause).mockResolvedValue(checkpoint(h.downloadId));
    const resumed = deferred<Error | null>();
    const removed = deferred<Error | null>();
    h.events.emit("resume-download", h.downloadId, resumed.resolve);
    await handoff.promise;
    h.events.emit("remove-download", h.downloadId, removed.resolve);
    id.resolve({ downloadId: h.downloadId });
    expect(await resumed.promise).toBeInstanceOf(UserCanceled);
    expect(await removed.promise).toBeNull();
    expect(window.api.downloader.pause).toHaveBeenCalledWith(h.downloadId);
    expect(h.getState().persistent.downloads.files[h.downloadId]).toBeUndefined();
    expect(h.dispatched).not.toContainEqual(
      finishDownload(h.downloadId, "failed", expect.anything()),
    );
  });

  for (const operation of ["pause", "remove"] as const) {
    test(`${operation} cancels a restore's unresolved lookup without marking it failed`, async ({
      makeDownloadAdapter,
    }) => {
      const h = makeDownloadAdapter({
        download: { state: "paused", urls: ["nxm://skyrimse/mods/123/files/456"] },
      });
      const entered = deferred<void>();
      const late = deferred<typeof result>();
      h.adapter.registerProtocol(
        "nxm",
        vi.fn(() => {
          entered.resolve();
          return late.promise;
        }),
      );
      const resumed = deferred<Error | null>();
      h.events.emit("resume-download", h.downloadId, resumed.resolve);
      await entered.promise;
      const controlled = deferred<Error | null>();
      h.events.emit(`${operation}-download`, h.downloadId, controlled.resolve);
      expect(await resumed.promise).toBeInstanceOf(UserCanceled);
      expect(await controlled.promise).toBeNull();
      expect(h.dispatched).not.toContainEqual(
        finishDownload(h.downloadId, "failed", expect.anything()),
      );
      if (operation === "pause")
        expect(h.dispatched).toContainEqual(pauseDownload(h.downloadId, true));
      late.resolve(result);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.getStates).not.toHaveBeenCalled();
    });
  }

  test("pause during a restore's IPC handoff preserves a paused record and checkpoint", async ({
    makeDownloadAdapter,
  }) => {
    const h = makeDownloadAdapter({ download: { state: "paused" } });
    const handoff = deferred<void>();
    const id = deferred<{ downloadId: string }>();
    h.start.mockImplementation(async (_dest: string, collationId: number) => {
      await resolveDownload()(collationId);
      handoff.resolve();
      return id.promise;
    });
    vi.mocked(window.api.downloader.pause).mockResolvedValue(checkpoint(h.downloadId));
    const resumed = deferred<Error | null>();
    h.events.emit("resume-download", h.downloadId, resumed.resolve);
    await handoff.promise;
    h.events.emit("pause-download", h.downloadId);
    id.resolve({ downloadId: h.downloadId });
    expect(await resumed.promise).toBeInstanceOf(UserCanceled);
    expect(window.api.downloader.pause).toHaveBeenCalledWith(h.downloadId);
    expect(h.dispatched).toContainEqual(pauseDownload(h.downloadId, true));
    expect(h.dispatched.some((action) => action.type === "SET_DOWNLOAD_CHECKPOINT")).toBe(true);
    expect(h.dispatched).not.toContainEqual(
      finishDownload(h.downloadId, "failed", expect.anything()),
    );
  });
});
