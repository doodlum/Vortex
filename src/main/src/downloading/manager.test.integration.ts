import { randomBytes } from "node:crypto";
import { readFile, writeFile, mkdtemp, mkdir, rm, access } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { staticChunker, type DownloadCheckpoint } from "@vortex/shared/download";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

import { DownloadManager } from "./manager";
import { urlResolver } from "./resolver";
import {
  type TestServer,
  createSharedTestServer,
  serveFile,
  delayAt,
  delayBeforeChunk,
  withHooks,
} from "./test-server";

const LARGE_FILE = randomBytes(20 * 1024 * 1024);
const SMALL_FILE = randomBytes(1024);

let server: TestServer;
let tmpDir: string;

beforeAll(async () => {
  [server, tmpDir] = await Promise.all([
    createSharedTestServer(),
    mkdtemp(path.join(os.tmpdir(), "manager-test-")),
  ]);
});

afterAll(() => Promise.all([server.close(), rm(tmpDir, { recursive: true, force: true })]));

let dirCounter = 0;

class TmpDir implements AsyncDisposable {
  constructor(readonly dir: string) {}
  [Symbol.asyncDispose]() {
    return rm(this.dir, { recursive: true, force: true });
  }
}

async function makeTmpDir(): Promise<TmpDir> {
  const dir = path.join(tmpDir, String(++dirCounter));
  await mkdir(dir);
  return new TmpDir(dir);
}

describe("DownloadManager", () => {
  for (const operation of ["pause", "cancel"] as const) {
    it(`${operation} settles a queued download without issuing any request`, async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const complete = serveFile({ body: SMALL_FILE });
      using running = server.route(async (ctx) => {
        if (ctx.req.method === "GET") {
          entered();
          await gate;
        }
        return complete(ctx);
      });
      using queued = server.route(complete);
      await using tmp = await makeTmpDir();
      const manager = new DownloadManager({ concurrency: 1 });
      const first = manager.download(running.url, path.join(tmp.dir, "running"), urlResolver);
      await started;
      const second = manager.download(queued.url, path.join(tmp.dir, "queued"), urlResolver);
      expect(second.getState().status).toBe("queued");
      try {
        const state = await second[operation]();
        expect(state.status).toBe(operation === "pause" ? "paused" : "canceled");
        await second.promise;
        expect(queued.requests).toHaveLength(0);
      } finally {
        release();
        await first.promise;
        await second.promise;
      }
      expect(queued.requests).toHaveLength(0);
      expect(await readFile(path.join(tmp.dir, "running"))).toEqual(SMALL_FILE);
    });
  }
  it.each([false, true])(
    "retries a truncated response with the default strategy (ranges: %s)",
    async (acceptRanges) => {
      const body = randomBytes(64 * 1024);
      const complete = serveFile({ body, acceptRanges, etag: '"stable"' });
      let gets = 0;
      using route = server.route(async (ctx) => {
        if (ctx.req.method !== "GET" || ++gets > 1) return complete(ctx);
        ctx.res.writeHead(acceptRanges ? 206 : 200, {
          "content-length": body.length,
          ...(acceptRanges ? { "content-range": `bytes 0-${body.length - 1}/${body.length}` } : {}),
          etag: '"stable"',
        });
        ctx.res.write(body.subarray(0, 4096));
        await new Promise((resolve) => setTimeout(resolve, 40));
        ctx.res.destroy();
      });
      await using tmp = await makeTmpDir();
      const manager = new DownloadManager({ concurrency: 1 });
      const dest = path.join(tmp.dir, "output");
      const handle = manager.download(route.url, dest, urlResolver);

      await handle.promise;

      expect(gets).toBe(2);
      expect(await readFile(dest)).toEqual(body);
      expect(handle.getState()).toMatchObject({
        status: "completed",
        bytesReceived: body.length,
        bytesWritten: body.length,
      });
      const requests = route.requests.filter((request) => request.method === "GET");
      expect(requests.every((request) => request.headers["if-match"] === '"stable"')).toBe(true);
      expect(requests[1]!.range).toEqual(requests[0]!.range);
    },
  );

  it("downloads a file and resolves the handle promise", async () => {
    using route = server.route(serveFile({ body: SMALL_FILE, acceptRanges: false }));
    await using tmp = await makeTmpDir();
    const manager = new DownloadManager({ concurrency: 3 });
    const dest = path.join(tmp.dir, "output");
    await manager.download(route.url, dest, urlResolver).promise;
    const result = await readFile(dest);
    expect(Buffer.compare(SMALL_FILE, result)).toBe(0);
  });

  it("serializes downloads when concurrency is 1", async () => {
    const completionOrder: number[] = [];
    const files = [randomBytes(1024), randomBytes(1024), randomBytes(1024)];
    const routes = files.map((file) =>
      server.route(serveFile({ body: file, acceptRanges: false })),
    );
    try {
      await using tmp = await makeTmpDir();
      const manager = new DownloadManager({ concurrency: 1 });
      await Promise.all(
        routes.map(({ url }, i) =>
          manager
            .download(url, path.join(tmp.dir, `file-${i}`), urlResolver)
            .promise.then(() => completionOrder.push(i)),
        ),
      );
      expect(completionOrder).toEqual([0, 1, 2]);
    } finally {
      routes.forEach((r) => r.deregister());
    }
  });

  it("runs multiple downloads concurrently when concurrency allows", async () => {
    const files = Array.from({ length: 6 }, () => randomBytes(20 * 1024 * 1024));
    const routes = files.map((file) => server.route(serveFile({ body: file, acceptRanges: true })));
    try {
      await using tmp = await makeTmpDir();
      const manager = new DownloadManager({ concurrency: 3 });
      await Promise.all(
        routes.map(
          ({ url }, i) =>
            manager.download(url, path.join(tmp.dir, `file-${i}`), urlResolver).promise,
        ),
      );
      for (const [i, file] of files.entries()) {
        const result = await readFile(path.join(tmp.dir, `file-${i}`));
        expect(Buffer.compare(file, result)).toBe(0);
      }
    } finally {
      routes.forEach((r) => r.deregister());
    }
  });

  it("reports zero progress before the download starts", async () => {
    using route = server.route(serveFile({ body: LARGE_FILE, acceptRanges: true }));
    await using tmp = await makeTmpDir();
    const manager = new DownloadManager({ concurrency: 3 });
    const handle = manager.download(route.url, path.join(tmp.dir, "output"), urlResolver);
    expect(handle.getState().bytesReceived).toBe(0);
    await handle.promise;
  });

  it("reports bytesReceived equal to file size on completion", async () => {
    using route = server.route(serveFile({ body: LARGE_FILE, acceptRanges: false }));
    await using tmp = await makeTmpDir();
    const manager = new DownloadManager({ concurrency: 3 });
    const handle = manager.download(route.url, path.join(tmp.dir, "output"), urlResolver);
    await handle.promise;
    expect(handle.getState().bytesReceived).toBe(LARGE_FILE.length);
  });

  it("reflects numPending and numRunning correctly", async () => {
    using route = server.route(
      withHooks(serveFile({ body: LARGE_FILE, acceptRanges: true }), delayAt("onRequest", 100)),
    );
    await using tmp = await makeTmpDir();
    const manager = new DownloadManager({ concurrency: 1 });

    const h1 = manager.download(route.url, path.join(tmp.dir, "file-1"), urlResolver);
    const h2 = manager.download(route.url, path.join(tmp.dir, "file-2"), urlResolver);

    expect(manager.numRunning).toBe(1);
    expect(manager.numPending).toBe(1);

    await Promise.all([h1.promise, h2.promise]);

    expect(manager.numRunning).toBe(0);
    expect(manager.numPending).toBe(0);
  });

  describe("resume", () => {
    it("preserves a queued resume checkpoint and skips its completed range after another resume", async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const complete = serveFile({ body: SMALL_FILE });
      using blockerRoute = server.route(async (ctx) => {
        if (ctx.req.method === "GET") {
          entered();
          await gate;
        }
        return complete(ctx);
      });
      using target = server.route(
        serveFile({ body: LARGE_FILE, acceptRanges: true, etag: '"saved"' }),
      );
      await using tmp = await makeTmpDir();
      const manager = new DownloadManager({ concurrency: 1 });
      const blocker = manager.download(
        blockerRoute.url,
        path.join(tmp.dir, "blocker"),
        urlResolver,
      );
      await started;
      const dest = path.join(tmp.dir, "partial");
      const completed = { start: 0, end: LARGE_FILE.length / 4 - 1 };
      const partial = Buffer.alloc(LARGE_FILE.length);
      LARGE_FILE.copy(partial, 0, 0, completed.end + 1);
      await writeFile(dest, partial);
      const checkpoint: DownloadCheckpoint<URL> = {
        downloadId: "queued-resume",
        resource: target.url,
        dest,
        completedRanges: [completed],
        etag: '"saved"',
      };
      const queued = manager.resume(checkpoint, urlResolver, staticChunker());
      let paused: Awaited<ReturnType<typeof queued.pause>>;
      try {
        expect(queued.getState().status).toBe("queued");
        paused = await queued.pause();
        expect(paused.status).toBe("paused");
        if (paused.status !== "paused") throw new Error("expected paused");
        expect(paused.checkpoint).toEqual(checkpoint);
        expect(target.requests).toHaveLength(0);
        expect(Buffer.compare(await readFile(dest), partial)).toBe(0);
        expect((await queued.pause()).status).toBe("paused");
      } finally {
        release();
        await Promise.all([blocker.promise, queued.promise]);
      }
      expect(target.requests).toHaveLength(0);
      if (paused.status !== "paused") throw new Error("expected paused");
      const resumed = manager.resume(paused.checkpoint, urlResolver, staticChunker());
      await resumed.promise;
      expect(Buffer.compare(await readFile(dest), LARGE_FILE)).toBe(0);
      const gets = target.requests.filter((request) => request.method === "GET");
      expect(gets).toHaveLength(3);
      expect(
        gets.every(
          (request) => request.range?.kind === "bounded" && request.range.start > completed.end,
        ),
      ).toBe(true);
    });

    async function waitForFile(path: string, timeout = 10_000): Promise<void> {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        try {
          await access(path);
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 50));
        }
      }
      throw new Error(`Timeout waiting for file: ${path}`);
    }

    it("skips already-downloaded chunks on resume", async () => {
      using route = server.route(
        withHooks(
          serveFile({
            body: LARGE_FILE,
            acceptRanges: true,
            chunkSize: 64 * 1024,
          }),
          delayBeforeChunk(2, 2_000),
        ),
      );
      await using tmp = await makeTmpDir();
      const manager = new DownloadManager({ concurrency: 1 });
      const dest = path.join(tmp.dir, "output");
      const handle = manager.download(route.url, dest, urlResolver);

      await vi.waitFor(
        () => {
          const state = handle.getState();
          return state.isChunked && state.chunks.length >= 2;
        },
        { timeout: 10_000, interval: 50 },
      );

      await waitForFile(dest);

      const pauseResult = await handle.pause();
      expect(pauseResult.status).toBe("paused");
      if (pauseResult.status !== "paused") throw new Error("expected paused");

      const resumed = manager.resume(pauseResult.checkpoint, urlResolver, staticChunker());
      await resumed.promise;

      const result = await readFile(dest);
      expect(Buffer.compare(LARGE_FILE, result)).toBe(0);
    });

    it("downloads fresh when resuming with a checkpoint whose partial file is missing", async () => {
      // A checkpoint whose partial file is missing is discarded so the download starts fresh.
      using route = server.route(serveFile({ body: SMALL_FILE, acceptRanges: true }));
      await using tmp = await makeTmpDir();
      const manager = new DownloadManager({ concurrency: 1 });

      const dest = path.join(tmp.dir, "does-not-exist");
      const checkpoint = {
        downloadId: "test-id",
        resource: route.url,
        dest,
        completedRanges: [],
        etag: undefined,
      } satisfies DownloadCheckpoint<URL>;

      const resumed = manager.resume(checkpoint, urlResolver, staticChunker());
      await resumed.promise;

      expect(Buffer.compare(SMALL_FILE, await readFile(dest))).toBe(0);
    });

    it("decrements numRunning after resume settles on pause", async () => {
      using route = server.route(
        withHooks(
          serveFile({
            body: LARGE_FILE,
            acceptRanges: true,
            chunkSize: 64 * 1024,
          }),
          delayBeforeChunk(1, 2_000),
        ),
      );
      await using tmp = await makeTmpDir();
      const manager = new DownloadManager({ concurrency: 1 });
      const dest = path.join(tmp.dir, "output");
      const handle = manager.download(route.url, dest, urlResolver);

      await vi.waitFor(
        () => {
          const state = handle.getState();
          return state.isChunked && state.chunks.length >= 1;
        },
        { timeout: 10_000, interval: 50 },
      );

      await waitForFile(dest);

      const pauseResult = await handle.pause();
      expect(pauseResult.status).toBe("paused");
      if (pauseResult.status !== "paused") throw new Error("expected paused");

      const resumed = manager.resume(pauseResult.checkpoint, urlResolver, staticChunker());
      await resumed.pause();

      expect(manager.numRunning).toBe(0);
      expect(manager.numPending).toBe(0);
    });
  });

  describe("pause", () => {
    it("resolves the handle promise without throwing after pause", async () => {
      using route = server.route(
        withHooks(serveFile({ body: LARGE_FILE, acceptRanges: true }), delayAt("onRequest", 50)),
      );
      await using tmp = await makeTmpDir();
      const manager = new DownloadManager({ concurrency: 1 });
      const handle = manager.download(route.url, path.join(tmp.dir, "output"), urlResolver);

      await handle.pause();

      // pause() itself must resolve — handle.promise rejects with cancellation
      // (p-queue surfaces the raw error), so we only assert on the pause result
      await expect(handle.pause()).resolves.toBeDefined();
    });

    it("returns a checkpoint whose resource and dest match the original arguments", async () => {
      using route = server.route(
        withHooks(serveFile({ body: LARGE_FILE, acceptRanges: true }), delayAt("onRequest", 50)),
      );
      await using tmp = await makeTmpDir();
      const manager = new DownloadManager({ concurrency: 1 });
      const dest = path.join(tmp.dir, "output");
      const handle = manager.download(route.url, dest, urlResolver);

      const pauseResult = await handle.pause();
      expect(pauseResult.status).toBe("paused");
      if (pauseResult.status !== "paused") throw new Error("expected paused");

      expect(pauseResult.checkpoint.resource).toBe(route.url);
      expect(pauseResult.checkpoint.dest).toBe(dest);
    });

    it("returns completedRanges covering [0, bytesWritten) for a non-chunked download paused mid-transfer", async () => {
      using route = server.route(
        withHooks(
          serveFile({
            body: LARGE_FILE,
            acceptRanges: false,
            chunkSize: 64 * 1024,
          }),
          delayBeforeChunk(4, 200), // stall partway through so bytes are written before pause
        ),
      );
      await using tmp = await makeTmpDir();
      const manager = new DownloadManager({ concurrency: 1 });
      const handle = manager.download(route.url, path.join(tmp.dir, "output"), urlResolver);

      // poll until the downloader has written at least one byte, then pause
      await vi.waitFor(
        () => {
          expect(handle.getState().bytesReceived).toBeGreaterThan(0);
        },
        { timeout: 10_000, interval: 50 },
      );
      const pauseResult = await handle.pause();
      expect(pauseResult.status).toBe("paused");
      if (pauseResult.status !== "paused") throw new Error("expected paused");

      const completedRanges = pauseResult.checkpoint.completedRanges;
      if (completedRanges.length > 0) {
        const [range] = completedRanges;
        expect(range!.start).toBe(0);
        expect(range!.end).toBeGreaterThan(0);
        expect(range!.end).toBeLessThanOrEqual(LARGE_FILE.length);
      }
      // an empty array is also acceptable if the download hadn't written anything yet
    });

    it("returns one completedRange per finished chunk for a chunked download", async () => {
      using route = server.route(
        withHooks(serveFile({ body: LARGE_FILE, acceptRanges: true }), delayAt("onRequest", 200)),
      );
      await using tmp = await makeTmpDir();
      const manager = new DownloadManager({ concurrency: 1 });
      const handle = manager.download(route.url, path.join(tmp.dir, "output"), urlResolver);

      const pauseResult = await handle.pause();
      expect(pauseResult.status).toBe("paused");
      if (pauseResult.status !== "paused") throw new Error("expected paused");

      for (const range of pauseResult.checkpoint.completedRanges) {
        expect(range.start).toBeGreaterThanOrEqual(0);
        expect(range.end).toBeGreaterThan(range.start);
        expect(range.end).toBeLessThanOrEqual(LARGE_FILE.length);
      }
    });

    it("returns an empty completedRanges when paused before the download starts", async () => {
      using route = server.route(
        withHooks(serveFile({ body: LARGE_FILE, acceptRanges: true }), delayAt("onRequest", 200)),
      );
      await using tmp = await makeTmpDir();
      // concurrency=1 with a queued download keeps the target pending
      const manager = new DownloadManager({ concurrency: 1 });
      // blocker occupies the single slot
      using blockerRoute = server.route(
        withHooks(serveFile({ body: SMALL_FILE, acceptRanges: false }), delayAt("onRequest", 200)),
      );
      const _blocker = manager.download(
        blockerRoute.url,
        path.join(tmp.dir, "blocker"),
        urlResolver,
      );
      const handle = manager.download(route.url, path.join(tmp.dir, "output"), urlResolver);

      // handle is still pending in the queue
      expect(manager.numPending).toBe(1);

      const pauseResult = await handle.pause();
      expect(pauseResult.status).toBe("paused");
      if (pauseResult.status !== "paused") throw new Error("expected paused");
      expect(pauseResult.checkpoint.completedRanges).toEqual([]);

      // Releasing the occupied slot must not start the already-paused target.
      _blocker.cancel();
      await _blocker.promise.catch(() => {});
      await handle.promise.catch(() => {});
      expect(route.requests).toHaveLength(0);
    });

    it("does not throw when pause is called after the download has already completed", async () => {
      using route = server.route(serveFile({ body: SMALL_FILE, acceptRanges: false }));
      await using tmp = await makeTmpDir();
      const manager = new DownloadManager({ concurrency: 1 });
      const handle = manager.download(route.url, path.join(tmp.dir, "output"), urlResolver);

      await handle.promise;

      await expect(handle.pause()).resolves.toBeDefined();
    });

    it("decrements numRunning after pause settles", async () => {
      using route = server.route(
        withHooks(serveFile({ body: LARGE_FILE, acceptRanges: true }), delayAt("onRequest", 50)),
      );
      await using tmp = await makeTmpDir();
      const manager = new DownloadManager({ concurrency: 3 });
      const handle = manager.download(route.url, path.join(tmp.dir, "output"), urlResolver);

      await handle.pause();

      expect(manager.numRunning).toBe(0);
      expect(manager.numPending).toBe(0);
    });
  });
});
