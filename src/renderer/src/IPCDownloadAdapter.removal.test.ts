import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { UserCanceled } from "@vortex/shared/errors";
import { afterAll, beforeAll, describe, expect, vi } from "vitest";

const realTimers = vi.hoisted(() => ({ setTimeout: globalThis.setTimeout }));
const paths = vi.hoisted(() => ({ root: "" }));
vi.mock("./util/getVortexPath", () => ({ default: () => paths.root }));
import { test } from "./test-utils/downloadAdapterTest";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
// The download selector caches userData, so this root must live for the whole suite.
beforeAll(async () => {
  paths.root = await mkdtemp(path.join(os.tmpdir(), "adapter-removal-"));
});
afterAll(async () => {
  const relative = path.relative(os.tmpdir(), paths.root);
  if (!relative.startsWith("adapter-removal-") || relative.includes(path.sep)) {
    throw new Error("Removal fixture root escaped its temporary directory");
  }
  await rm(paths.root, { recursive: true, force: true });
});

describe("download removal ownership", () => {
  test("repeated removal and a canceled poll wait for native settlement and actual file deletion", async ({
    makeDownloadAdapter,
  }) => {
    const h = makeDownloadAdapter({ download: { state: "paused" } });
    const terminal = vi.fn();
    h.events.emit("resume-download", h.downloadId, terminal);
    await h.started.promise;
    await vi.advanceTimersByTimeAsync(0);
    await mkdir(path.dirname(h.dest), { recursive: true });
    await writeFile(h.dest, "partial archive");
    const stop = deferred();
    vi.mocked(window.api.downloader.cancel).mockImplementation(() => stop.promise);
    const removedA = vi.fn();
    const removedB = vi.fn();
    h.events.emit("remove-download", h.downloadId, removedA);
    h.events.emit("remove-download", h.downloadId, removedB);
    h.getStates.mockResolvedValue({
      [h.downloadId]: {
        status: "canceled",
        error: null,
        bytesReceived: 15,
        bytesWritten: 15,
        size: 100,
        isChunked: false,
      },
    });
    try {
      await vi.advanceTimersByTimeAsync(200);
      expect(removedA).not.toHaveBeenCalled();
      expect(removedB).not.toHaveBeenCalled();
      expect(terminal).not.toHaveBeenCalled();
      expect(h.getState().persistent.downloads.files[h.downloadId]).toBeDefined();
      expect(await readFile(h.dest, "utf8")).toBe("partial archive");
      expect(window.api.downloader.cancel).toHaveBeenCalledTimes(1);
      const resume = vi.fn();
      h.events.emit("resume-download", h.downloadId, resume);
      await vi.waitFor(() => expect(resume).toHaveBeenCalledWith(expect.any(Error)));
      expect(h.start).toHaveBeenCalledTimes(1);
    } finally {
      stop.resolve();
      await vi.waitFor(() => expect(removedA).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(removedB).toHaveBeenCalledTimes(1));
    }
    expect(removedA).toHaveBeenCalledWith(null);
    expect(removedB).toHaveBeenCalledWith(null);
    expect(terminal).toHaveBeenCalledTimes(1);
    expect(terminal).toHaveBeenCalledWith(expect.any(UserCanceled), h.downloadId);
    expect(h.getState().persistent.downloads.files[h.downloadId]).toBeUndefined();
    expect(h.dispatched.filter((action) => action.type === "REMOVE_DOWNLOAD")).toHaveLength(1);
    await expect(access(h.dest)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("removal during completion", () => {
  test("waits for hashing and suppresses late success and auto-install", async ({
    makeDownloadAdapter,
  }) => {
    const h = makeDownloadAdapter({ download: { state: "paused" }, automationInstall: true });
    const terminal = vi.fn();
    h.events.emit("resume-download", h.downloadId, terminal);
    await h.started.promise;
    await vi.advanceTimersByTimeAsync(0);
    await mkdir(path.dirname(h.dest), { recursive: true });
    await writeFile(h.dest, "complete archive");
    const gate = deferred();
    const entered = deferred();
    const compute = vi.fn(async () => {
      entered.resolve();
      await gate.promise;
      return { hash: "md5", numBytes: 16 };
    });
    window.api.hash = { compute } as typeof window.api.hash;
    const finished = vi.fn();
    const install = vi.fn();
    h.events.on("did-finish-download", finished);
    h.events.on("start-install-download", install);
    h.getStates.mockResolvedValue({
      [h.downloadId]: {
        status: "completed",
        error: null,
        bytesReceived: 16,
        bytesWritten: 16,
        size: 16,
        isChunked: false,
      },
    });
    const removed = vi.fn();
    try {
      await vi.advanceTimersByTimeAsync(200);
      await entered.promise;
      h.events.emit("remove-download", h.downloadId, removed);
      await vi.advanceTimersByTimeAsync(200);
      // Let real filesystem I/O settle as well as advancing the fake poll clock.
      await new Promise<void>((resolve) => realTimers.setTimeout(resolve, 100));
      expect(removed, "removal must retain ownership until hash work stops").not.toHaveBeenCalled();
      expect(terminal).not.toHaveBeenCalled();
      expect(await readFile(h.dest, "utf8")).toBe("complete archive");
    } finally {
      gate.resolve();
      await vi.waitFor(() => expect(removed).toHaveBeenCalledTimes(1));
    }
    expect(removed).toHaveBeenCalledWith(null);
    expect(terminal).toHaveBeenCalledTimes(1);
    expect(terminal).toHaveBeenCalledWith(expect.any(UserCanceled), h.downloadId);
    expect(finished).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
    expect(h.getState().persistent.downloads.files[h.downloadId]).toBeUndefined();
    expect(h.dispatched.filter((action) => action.type === "FINISH_DOWNLOAD")).toHaveLength(0);
    await expect(access(h.dest)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
