import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { expect, it, vi } from "vitest";

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
vi.mock("../ipc", () => ({
  betterIpcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(channel, handler),
  },
}));
import { init } from "./ipc";
import { DownloadManager } from "./manager";
import { createSharedTestServer, serveFile } from "./test-server";

it("cancel IPC waits for actual native worker completion", async () => {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const server = await createSharedTestServer();
  using route = server.route(serveFile({ body: Buffer.alloc(2048, 7), acceptRanges: true }));
  const dir = await mkdtemp(path.join(os.tmpdir(), "native-cancel-"));
  const manager = new DownloadManager({ concurrency: 1 });
  const handle = manager.download(
    route.url,
    path.join(dir, "output"),
    () =>
      Promise.resolve({
        probeEndpoint: { url: route.url },
        chunkEndpoint: async (chunk) => {
          if (chunk.index === 1) {
            entered();
            await gate;
          }
          return { url: route.url };
        },
      }),
    () => [
      { index: 0, range: { start: 0, end: 1023 } },
      { index: 1, range: { start: 1024, end: 2047 } },
    ],
  );
  await started;
  init(manager);
  let finished = false;
  const cancelled = Promise.resolve(
    handlers.get("download:cancel")!({}, handle.downloadId),
  ).finally(() => {
    finished = true;
  });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(finished, "native cancel acknowledgement must mean physical stop").toBe(false);
    expect(manager.numRunning).toBe(1);
  } finally {
    release();
    await cancelled;
    await handle.promise;
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
