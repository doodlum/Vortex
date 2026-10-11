import { mkdtemp, readFile, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { Chunk, Resolver } from "@vortex/shared/download";
import { RateLimiter } from "limiter";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { download } from "./downloader";
import { DownloadManager } from "./manager";
import {
  createSharedTestServer,
  serveFile,
  serveStatus,
  withHooks,
  type TestServer,
} from "./test-server";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let server: TestServer;
beforeAll(async () => {
  server = await createSharedTestServer();
});
afterAll(async () => {
  await server.close();
});

const body = Buffer.alloc(6 * 1024, 7);
const chunks: Chunk[] = Array.from({ length: 6 }, (_, index) => ({
  index,
  range: { start: index * 1024, end: (index + 1) * 1024 - 1 },
}));
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("physical download lifetime", () => {
  it.each([2, 4, 6])(
    "drains siblings before reporting chunk failure (concurrency %s)",
    async (chunkConcurrency) => {
      const gate = deferred();
      const entered = deferred();
      const failed = deferred();
      const file = serveFile({ body, acceptRanges: true });
      using route = server.route(file);
      using broken = server.route(async (ctx) => {
        await entered.promise;
        await serveStatus(400)(ctx);
      });
      const endpointCalls: number[] = [];
      const resolver: Resolver<URL> = () =>
        Promise.resolve({
          probeEndpoint: { url: route.url },
          chunkEndpoint: async (chunk) => {
            endpointCalls.push(chunk.index);
            if (chunk.index === 0) return { url: broken.url };
            entered.resolve();
            await gate.promise;
            return { url: route.url };
          },
        });
      const dir = await mkdtemp(path.join(os.tmpdir(), "download-lifetime-"));
      let settled = false;
      const outcome = download(
        route.url,
        path.join(dir, "output"),
        {
          resolver,
          chunker: () => chunks,
          retry: () => {
            failed.resolve();
            return { retry: false };
          },
        },
        { chunkConcurrency },
      )
        .then(
          () => ({ error: undefined }),
          (error: unknown) => ({ error }),
        )
        .finally(() => {
          settled = true;
        });
      try {
        await failed.promise;
        await nextTurn();
        await nextTurn();
        expect(
          settled,
          "failed aggregate must retain ownership while a sibling resolver is pending",
        ).toBe(false);
        expect(endpointCalls).toEqual(
          Array.from({ length: chunkConcurrency }, (_, index) => index),
        );
        expect(route.requests.filter((request) => request.method === "GET")).toHaveLength(0);
      } finally {
        gate.resolve();
        await outcome;
        await rm(dir, { recursive: true, force: true });
      }
      const result = await outcome;
      expect(result.error).toMatchObject({ data: { kind: "http:bad-status", statusCode: 400 } });
      expect(route.requests.filter((request) => request.method === "GET")).toHaveLength(0);
    },
  );

  it("does not write a buffered response after cancellation during a token wait", async () => {
    const gate = deferred();
    const entered = deferred();
    const controller = new AbortController();
    const limiter = new RateLimiter({ tokensPerInterval: 1024, interval: "second" });
    const tokens = vi.spyOn(limiter, "removeTokens").mockImplementation(async () => {
      entered.resolve();
      await gate.promise;
      return 0;
    });
    using route = server.route(serveFile({ body: body.subarray(0, 1024) }));
    const dir = await mkdtemp(path.join(os.tmpdir(), "download-tokens-"));
    const dest = path.join(dir, "output");
    let settled = false;
    const progress = new (await import("./progress")).ProgressReporter();
    const outcome = download(
      route.url,
      dest,
      {
        resolver: (url) => Promise.resolve({ url }),
        chunker: () => [],
        rateLimiter: limiter,
      },
      { abortSignal: controller.signal, progressReporter: progress },
    )
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    try {
      await entered.promise;
      controller.abort();
      await nextTurn();
      expect(settled).toBe(false);
      gate.resolve();
      expect(await outcome).toMatchObject({ data: { kind: "user-canceled" } });
      expect(progress.getProgress().bytesWritten).toBe(0);
      expect(await readFile(dest)).toHaveLength(0);
    } finally {
      gate.resolve();
      await outcome;
      tokens.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("holds the manager slot and both pause calls while a chunk resolver remains pending", async () => {
    const gate = deferred();
    const entered = deferred();
    using route = server.route(serveFile({ body, acceptRanges: true }));
    using queuedRoute = server.route(serveFile({ body: body.subarray(0, 1024) }));
    const resolver: Resolver<URL> = () =>
      Promise.resolve({
        probeEndpoint: { url: route.url },
        chunkEndpoint: async (chunk) => {
          if (chunk.index === 1) {
            entered.resolve();
            await gate.promise;
          }
          return { url: route.url };
        },
      });
    const dir = await mkdtemp(path.join(os.tmpdir(), "download-pauses-"));
    const dest = path.join(dir, "first");
    const manager = new DownloadManager({ concurrency: 1 });
    const first = manager.download(route.url, dest, resolver, () => chunks);
    await entered.promise;
    const queued = manager.download(queuedRoute.url, path.join(dir, "next"), (url) =>
      Promise.resolve({
        url,
      }),
    );
    const overlaps: ReturnType<typeof manager.download>[] = [];
    let firstPauseDone = false;
    let secondPauseDone = false;
    const firstPause = first.pause().finally(() => {
      firstPauseDone = true;
    });
    const secondPause = first.pause().finally(() => {
      secondPauseDone = true;
    });
    try {
      await nextTurn();
      await nextTurn();
      expect(secondPauseDone, "a repeated pause must await the same physical stop").toBe(false);
      expect(firstPauseDone).toBe(false);
      expect(manager.numRunning).toBe(1);
      expect(queuedRoute.requests).toHaveLength(0);
      expect(() => {
        overlaps.push(
          manager.download(
            route.url,
            path.join(dir, "other"),
            resolver,
            () => chunks,
            undefined,
            first.downloadId,
          ),
        );
      }).toThrow("already owns");
      expect(() => {
        overlaps.push(manager.download(route.url, dest, resolver, () => chunks));
      }).toThrow("already owns");
    } finally {
      gate.resolve();
      overlaps.forEach((handle) => handle.cancel());
      await Promise.all([
        firstPause,
        secondPause,
        first.promise,
        queued.promise,
        ...overlaps.map((handle) => handle.promise),
      ]);
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("resumes from exactly the physically written single-stream prefix", async () => {
    const gate = deferred();
    const prefixSent = deferred();
    const prefix = 1024;
    const content = Buffer.from(Array.from({ length: 8192 }, (_, index) => (index % 255) + 1));
    using route = server.route(
      withHooks(serveFile({ body: content, acceptRanges: true, chunkSize: prefix }), {
        beforeChunk: async (ctx, chunk) => {
          if (!ctx.range && chunk.index === 1) {
            prefixSent.resolve();
            await gate.promise;
          }
        },
      }),
    );
    const dir = await mkdtemp(path.join(os.tmpdir(), "download-prefix-"));
    const dest = path.join(dir, "output");
    const manager = new DownloadManager({ concurrency: 1 });
    const resolver: Resolver<URL> = (url) => Promise.resolve({ url });
    const first = manager.download(route.url, dest, resolver, () => []);
    let resumed: ReturnType<typeof manager.download> | undefined;
    try {
      await prefixSent.promise;
      await vi.waitFor(() => expect(first.getState().bytesWritten).toBe(prefix));
      const result = await first.pause();
      expect(result.status).toBe("paused");
      if (result.status !== "paused") throw Error("Expected paused checkpoint");
      expect(result.checkpoint.completedRanges).toEqual([{ start: 0, end: prefix - 1 }]);
      expect(await readFile(dest)).toEqual(content.subarray(0, prefix));
      resumed = manager.resume(result.checkpoint, resolver, () => []);
      await resumed.promise;
      expect(route.requests.filter((request) => request.method === "GET")[1]!.range).toEqual({
        kind: "bounded",
        start: prefix,
        end: content.length - 1,
      });
      expect(await readFile(dest)).toEqual(content);
    } finally {
      gate.resolve();
      first.cancel();
      resumed?.cancel();
      await first.promise;
      await resumed?.promise;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
