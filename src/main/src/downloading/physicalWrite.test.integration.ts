import type * as NodeFilesystem from "node:fs/promises";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { download } from "./downloader";
import { DownloadManager } from "./manager";
import { ProgressReporter } from "./progress";
import { createSharedTestServer, serveFile, serveStatus, type TestServer } from "./test-server";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof NodeFilesystem>();
  return { ...actual, open: vi.fn(actual.open) };
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
const body = Buffer.from(Array.from({ length: 2048 }, (_, index) => index % 251));
let server: TestServer;
beforeAll(async () => {
  server = await createSharedTestServer();
});
afterAll(async () => {
  await server.close();
});

describe("physical file-write ownership", () => {
  it.each(["cancel", "pause", "chunk failure"])(
    "holds the file and manager slot through a pending write on %s",
    async (stop) => {
      const gate = deferred();
      const entered = deferred();
      const failed = deferred();
      let closed = false;
      const realOpen = vi.mocked(open).getMockImplementation()!;
      vi.mocked(open).mockImplementationOnce(async (...args) => {
        const fd = await realOpen(...args);
        const realWrite = fd.write.bind(fd);
        const realClose = fd.close.bind(fd);
        vi.spyOn(fd, "write").mockImplementation((async (
          buffer: Uint8Array,
          offset: number,
          length: number,
          position: number,
        ) => {
          entered.resolve();
          await gate.promise;
          return realWrite(buffer, offset, length, position);
        }) as typeof fd.write);
        vi.spyOn(fd, "close").mockImplementation(async () => {
          closed = true;
          await realClose();
        });
        return fd;
      });
      using route = server.route(serveFile({ body, acceptRanges: true }));
      using next = server.route(serveFile({ body }));
      using broken = server.route(async (ctx) => {
        await entered.promise;
        await serveStatus(400)(ctx);
      });
      const dir = await mkdtemp(path.join(os.tmpdir(), "download-write-lifetime-"));
      const manager = new DownloadManager({ concurrency: 1 });
      const chunked = stop === "chunk failure";
      const first = manager.download(
        route.url,
        path.join(dir, "first"),
        () =>
          Promise.resolve({
            probeEndpoint: { url: route.url },
            chunkEndpoint: (chunk) =>
              Promise.resolve({ url: chunk.index === 0 ? route.url : broken.url }),
          }),
        () =>
          chunked
            ? [
                { index: 0, range: { start: 0, end: 1023 } },
                { index: 1, range: { start: 1024, end: 2047 } },
              ]
            : [],
        () => {
          failed.resolve();
          return { retry: false };
        },
      );
      let settled = false;
      const outcome = first.promise
        .catch((error: unknown) => error)
        .finally(() => {
          settled = true;
        });
      await entered.promise;
      const queued = manager.download(next.url, path.join(dir, "next"), (url) =>
        Promise.resolve({ url }),
      );
      let pause: ReturnType<typeof first.pause> | undefined;
      if (stop === "cancel") first.cancel();
      else if (stop === "pause") pause = first.pause();
      else await failed.promise;
      try {
        await nextTurn();
        await nextTurn();
        expect(settled).toBe(false);
        expect(closed).toBe(false);
        expect(manager.numRunning).toBe(1);
        expect(next.requests).toHaveLength(0);
      } finally {
        gate.resolve();
        await outcome;
        await pause;
        await queued.promise;
        await rm(dir, { recursive: true, force: true });
      }
      expect(closed).toBe(true);
      if (chunked) expect(await outcome).toMatchObject({ data: { kind: "http:bad-status" } });
      else {
        expect(await outcome).toBeUndefined();
        expect(first.getState().status).toBe(stop === "pause" ? "paused" : "canceled");
      }
    },
  );

  it("writes the entire buffer after a partial successful filesystem write", async () => {
    const realOpen = vi.mocked(open).getMockImplementation()!;
    let writes = 0;
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const fd = await realOpen(...args);
      const realWrite = fd.write.bind(fd);
      vi.spyOn(fd, "write").mockImplementation((async (
        buffer: Uint8Array,
        offset: number,
        length: number,
        position: number,
      ) => {
        writes++;
        return realWrite(buffer, offset, Math.min(length, 257), position);
      }) as typeof fd.write);
      return fd;
    });
    using route = server.route(serveFile({ body }));
    const dir = await mkdtemp(path.join(os.tmpdir(), "download-partial-write-"));
    const dest = path.join(dir, "output");
    const manager = new DownloadManager({ concurrency: 1 });
    const handle = manager.download(route.url, dest, (url) => Promise.resolve({ url }));
    try {
      await handle.promise;
      expect(await readFile(dest)).toEqual(body);
      expect(handle.getState().bytesWritten).toBe(body.length);
      expect(writes).toBeGreaterThan(1);
    } finally {
      await handle.promise.catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("interrupted write classification", () => {
  it.each([257, 2048])(
    "preserves cancellation after an in-flight write of %s bytes",
    async (writeLimit) => {
      const gate = deferred();
      const entered = deferred();
      const controller = new AbortController();
      const realOpen = vi.mocked(open).getMockImplementation()!;
      vi.mocked(open).mockImplementationOnce(async (...args) => {
        const fd = await realOpen(...args);
        const realWrite = fd.write.bind(fd);
        vi.spyOn(fd, "write").mockImplementation((async (
          buffer: Uint8Array,
          offset: number,
          length: number,
          position: number,
        ) => {
          entered.resolve();
          await gate.promise;
          return realWrite(buffer, offset, Math.min(length, writeLimit), position);
        }) as typeof fd.write);
        return fd;
      });
      using route = server.route(serveFile({ body }));
      const dir = await mkdtemp(path.join(os.tmpdir(), "download-write-cancel-"));
      const dest = path.join(dir, "output");
      const progress = new ProgressReporter();
      const outcome = download(
        route.url,
        dest,
        { resolver: (url) => Promise.resolve({ url }), chunker: () => [] },
        { abortSignal: controller.signal, progressReporter: progress },
      ).catch((error: unknown) => error);
      try {
        await entered.promise;
        controller.abort();
        gate.resolve();
        expect(await outcome).toMatchObject({ data: { kind: "user-canceled" } });
        const bytes = await readFile(dest);
        expect(bytes).toEqual(body.subarray(0, writeLimit));
        expect(progress.getProgress().bytesWritten).toBe(bytes.length);
      } finally {
        gate.resolve();
        await outcome;
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it("canceling retry backoff issues no further GET", async () => {
    const entered = deferred();
    const manager = new DownloadManager({ concurrency: 1 });
    using route = server.route(async (ctx) => {
      if (ctx.req.method === "HEAD") return serveFile({ body })(ctx);
      return serveStatus(503)(ctx);
    });
    const dir = await mkdtemp(path.join(os.tmpdir(), "download-backoff-cancel-"));
    const handle = manager.download(
      route.url,
      path.join(dir, "output"),
      (url) => Promise.resolve({ url }),
      () => [],
      () => {
        entered.resolve();
        return { retry: true, delayMs: 10_000 };
      },
    );
    try {
      await entered.promise;
      handle.cancel();
      await handle.promise;
      expect(handle.getState().status).toBe("canceled");
      expect(route.requests.filter((req) => req.method === "GET")).toHaveLength(1);
    } finally {
      handle.cancel();
      await handle.promise.catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  });
});

it("pauses during retry truncation with only the retained physical checkpoint prefix", async () => {
  const gate = deferred();
  const entered = deferred();
  const prefix = 512;
  let truncations = 0;
  let gets = 0;
  const realOpen = vi.mocked(open).getMockImplementation()!;
  vi.mocked(open).mockImplementationOnce(async (...args) => {
    const fd = await realOpen(...args);
    const realTruncate = fd.truncate.bind(fd);
    vi.spyOn(fd, "truncate").mockImplementation(async (length) => {
      if (length === prefix && ++truncations === 2) {
        entered.resolve();
        await gate.promise;
      }
      await realTruncate(length);
    });
    return fd;
  });
  using route = server.route(async (ctx) => {
    if (ctx.req.method !== "GET" || ++gets > 1)
      return serveFile({ body, acceptRanges: true, etag: '"stable"' })(ctx);
    ctx.res.writeHead(206, {
      "content-length": body.length - prefix,
      "content-range": "bytes " + prefix + "-" + (body.length - 1) + "/" + body.length,
      etag: '"stable"',
    });
    ctx.res.write(body.subarray(prefix, prefix * 2));
    await new Promise((resolve) => setTimeout(resolve, 40));
    ctx.res.destroy();
  });
  const dir = await mkdtemp(path.join(os.tmpdir(), "download-retry-pause-"));
  const dest = path.join(dir, "output");
  await writeFile(dest, body.subarray(0, prefix));
  const manager = new DownloadManager({ concurrency: 1 });
  const resolver = (url: URL) => Promise.resolve({ url });
  const first = manager.resume(
    {
      downloadId: "resumed",
      resource: route.url,
      dest,
      completedRanges: [{ start: 0, end: prefix - 1 }],
      etag: '"stable"',
    },
    resolver,
    () => [],
    ({ attempt }) => ({ retry: attempt === 1, delayMs: 0 }),
  );
  let resumed: ReturnType<typeof manager.resume> | undefined;
  try {
    await entered.promise;
    const paused = first.pause();
    gate.resolve();
    const result = await paused;
    expect(result.status).toBe("paused");
    if (result.status !== "paused") throw Error("Expected checkpoint");
    expect(result.checkpoint.completedRanges).toEqual([{ start: 0, end: prefix - 1 }]);
    expect(await readFile(dest)).toEqual(body.subarray(0, prefix));
    resumed = manager.resume(result.checkpoint, resolver, () => []);
    await resumed.promise;
    expect(await readFile(dest)).toEqual(body);
    expect(route.requests.filter((req) => req.method === "GET").at(-1)?.range).toEqual({
      kind: "bounded",
      start: prefix,
      end: body.length - 1,
    });
  } finally {
    gate.resolve();
    first.cancel();
    resumed?.cancel();
    await first.promise.catch(() => {});
    await resumed?.promise.catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});
