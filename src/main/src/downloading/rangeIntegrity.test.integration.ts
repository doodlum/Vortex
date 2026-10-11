import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { Chunk } from "@vortex/shared/download";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { download } from "./downloader";
import { DownloadManager } from "./manager";
import { createSharedTestServer, serveFile, type TestServer } from "./test-server";

let server: TestServer;
beforeAll(async () => {
  server = await createSharedTestServer();
});
afterAll(async () => {
  await server.close();
});
const body = Buffer.from(Array.from({ length: 8192 }, (_, index) => (index % 255) + 1));
const chunks: Chunk[] = [
  { index: 0, range: { start: 0, end: 4095 } },
  { index: 1, range: { start: 4096, end: 8191 } },
];

describe("download response integrity", () => {
  it.each([
    "short full response",
    "short chunk",
    "wrong coordinates",
    "ignored Range",
    "changed total",
    "changed ETag",
    "short unframed body",
    "unexpected partial response",
  ])("does not complete after %s", async (fault) => {
    const chunked = ["short chunk", "wrong coordinates", "ignored Range", "changed total"].includes(
      fault,
    );
    let gets = 0;
    const complete = serveFile({ body, acceptRanges: true, etag: '"stable"' });
    using route = server.route(async (ctx) => {
      if (ctx.req.method === "HEAD") return complete(ctx);
      gets++;
      const requested =
        ctx.range?.kind === "bounded" ? ctx.range : { start: 0, end: body.length - 1 };
      let start = requested.start;
      let end = requested.end;
      let total = body.length;
      let status = chunked ? 206 : 200;
      if (fault === "short chunk") end = start + 2047;
      if (fault === "wrong coordinates") {
        start = (start + 4096) % body.length;
        end = start + 4095;
      }
      if (fault === "changed total") total *= 2;
      if (fault === "ignored Range") status = 200;
      if (fault === "unexpected partial response") {
        status = 206;
        end = 4095;
      }
      const responseBody =
        fault.startsWith("short full") || fault === "short unframed body"
          ? body.subarray(0, 4096)
          : body.subarray(start, end + 1);
      ctx.res.writeHead(status, {
        ...(fault !== "short unframed body" ? { "content-length": responseBody.length } : {}),
        ...(status === 206 ? { "content-range": "bytes " + start + "-" + end + "/" + total } : {}),
        etag: fault === "changed ETag" ? '"changed"' : '"stable"',
      });
      ctx.res.end(responseBody);
    });
    const dir = await mkdtemp(path.join(os.tmpdir(), "download-integrity-"));
    const manager = new DownloadManager({ concurrency: 1 });
    const handle = manager.download(
      route.url,
      path.join(dir, "output"),
      (url) => Promise.resolve({ url }),
      () => (chunked ? chunks : []),
    );
    try {
      await expect(handle.promise).rejects.toMatchObject({
        data: { kind: "http:protocol-violation" },
      });
      expect(handle.getState().status).toBe("failed");
      expect(gets).toBeLessThanOrEqual(chunked ? 2 : 1);
    } finally {
      await handle.promise.catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each([false, true])(
    "restarts a non-range resume instead of appending the full body (known size %s)",
    async (knownSize) => {
      using route = server.route(async (ctx) => {
        if (ctx.req.method === "HEAD" && !knownSize) {
          ctx.res.writeHead(200);
          ctx.res.end();
          return;
        }
        await serveFile({ body })(ctx);
      });
      const dir = await mkdtemp(path.join(os.tmpdir(), "download-nonrange-"));
      const dest = path.join(dir, "output");
      await writeFile(dest, Buffer.alloc(body.length * 2, 3));
      try {
        await download(
          route.url,
          dest,
          { resolver: (url) => Promise.resolve({ url }), chunker: () => [] },
          {
            checkpoint: { etag: undefined, completedRanges: [{ start: 0, end: 1023 }] },
          },
        );
        expect(await readFile(dest)).toEqual(body);
        expect(route.requests.filter((request) => request.method === "GET")).toHaveLength(1);
        expect(route.requests.find((request) => request.method === "GET")!.range).toBeNull();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});

describe("identity response boundary", () => {
  it.each(["HEAD", "full GET", "chunk GET"])(
    "rejects unexpected encoding on %s before writing",
    async (boundary) => {
      const chunked = boundary === "chunk GET";
      using route = server.route((ctx) => {
        if (ctx.req.method === "HEAD") {
          ctx.res.writeHead(200, {
            ...(boundary === "HEAD" ? { "content-encoding": "gzip" } : {}),
            ...(chunked ? { "accept-ranges": "bytes", "content-length": body.length } : {}),
          });
          ctx.res.end();
          return Promise.resolve();
        }
        const range =
          ctx.range?.kind === "bounded" ? ctx.range : { start: 0, end: body.length - 1 };
        const bytes = body.subarray(range.start, range.end + 1);
        // Counts and coordinates deliberately match. Encoding alone must refuse the body.
        ctx.res.writeHead(chunked ? 206 : 200, {
          "content-encoding": "gzip",
          "content-length": bytes.length,
          ...(chunked
            ? { "content-range": "bytes " + range.start + "-" + range.end + "/" + body.length }
            : {}),
        });
        ctx.res.end(bytes);
        return Promise.resolve();
      });
      const dir = await mkdtemp(path.join(os.tmpdir(), "download-encoding-"));
      const dest = path.join(dir, "output");
      try {
        await expect(
          download(route.url, dest, {
            resolver: (url) => Promise.resolve({ url }),
            chunker: () => (chunked ? chunks : []),
          }),
        ).rejects.toMatchObject({ data: { kind: "http:protocol-violation" } });
        if (boundary !== "HEAD") expect(await readFile(dest)).toHaveLength(0);
        else expect(route.requests.filter((req) => req.method === "GET")).toHaveLength(0);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});

describe("retry and restored file boundaries", () => {
  it("removes a failed attempt suffix when an unknown-size retry returns a shorter body", async () => {
    let gets = 0;
    const successful = body.subarray(0, 2048);
    using route = server.route(async (ctx) => {
      if (ctx.req.method === "HEAD") {
        ctx.res.writeHead(200);
        ctx.res.end();
        return;
      }
      if (++gets === 1) {
        ctx.res.writeHead(200, { "content-length": body.length });
        ctx.res.write(body.subarray(0, 6144));
        await new Promise((resolve) => setTimeout(resolve, 40));
        ctx.res.destroy();
        return;
      }
      ctx.res.writeHead(200, { "content-length": successful.length });
      ctx.res.end(successful);
    });
    const dir = await mkdtemp(path.join(os.tmpdir(), "download-retry-suffix-"));
    const dest = path.join(dir, "output");
    const manager = new DownloadManager({ concurrency: 1 });
    const handle = manager.download(
      route.url,
      dest,
      (url) => Promise.resolve({ url }),
      () => [],
      ({ attempt }) => ({ retry: attempt === 1, delayMs: 0 }),
    );
    try {
      await handle.promise;
      expect(gets).toBe(2);
      expect(await readFile(dest)).toEqual(successful);
      expect(handle.getState()).toMatchObject({
        status: "completed",
        bytesWritten: successful.length,
      });
    } finally {
      await handle.promise.catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each([false, true])(
    "redownloads checkpoint ranges missing from the actual file (chunked %s)",
    async (chunked) => {
      using route = server.route(serveFile({ body, acceptRanges: true, etag: '"stable"' }));
      const dir = await mkdtemp(path.join(os.tmpdir(), "download-missing-prefix-"));
      const dest = path.join(dir, "output");
      await writeFile(dest, body.subarray(0, 1024));
      try {
        await download(
          route.url,
          dest,
          { resolver: (url) => Promise.resolve({ url }), chunker: () => (chunked ? chunks : []) },
          {
            checkpoint: { etag: '"stable"', completedRanges: [{ start: 0, end: body.length - 1 }] },
          },
        );
        expect(await readFile(dest)).toEqual(body);
        expect(route.requests.filter((req) => req.method === "GET")).toHaveLength(chunked ? 2 : 1);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
