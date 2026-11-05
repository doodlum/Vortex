import * as path from "node:path";

import PromiseBB from "bluebird";
import { afterEach, beforeEach, expect, vi } from "vitest";

import { test } from "../../test-utils/deploymentTest";
import { UserCanceled } from "../../util/CustomErrors";
import type * as utilFs from "../../util/fs";

const io = vi.hoisted(() => ({ walk: vi.fn(), unlink: vi.fn() }));
vi.mock("turbowalk", () => ({ default: io.walk }));
vi.mock("../../util/fs", async (original) => ({
  ...(await original<typeof utilFs>()),
  unlinkAsync: (file: string) => io.unlink(file),
}));
const NativePromise = (async () => undefined)().constructor as PromiseConstructor;
beforeEach(() => {
  vi.resetAllMocks();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

test.for([
  { runtime: "native", cancellation: false },
  { runtime: "bluebird", cancellation: false },
  { runtime: "native", cancellation: true },
  { runtime: "bluebird", cancellation: true },
] as const)(
  "Windows purge reports unlink failure after peers settle: $runtime, cancel=$cancellation",
  async ({ runtime, cancellation }, { makeDeployment }) => {
    const h = makeDeployment({ files: { "bad.txt": "bad", "slow.txt": "slow" } });
    const failure = cancellation
      ? new UserCanceled()
      : Object.assign(new Error("file busy"), { code: "EBUSY" });
    let releaseSlow: () => void;
    const slow = new NativePromise<void>((resolve) => {
      releaseSlow = resolve;
    });
    io.walk.mockImplementation((root, callback) => {
      callback([
        { filePath: path.join(root, "bad.txt"), linkCount: 2, idStr: "9007199254740992" },
        { filePath: path.join(root, "slow.txt"), linkCount: 2, idStr: "9007199254740993" },
        ...(root === h.stagingDir
          ? []
          : [
              {
                filePath: path.join(root, "unrelated.txt"),
                linkCount: 2,
                idStr: "9007199254740994",
              },
            ]),
      ]);
      return PromiseBB.resolve();
    });
    io.unlink.mockImplementation((file) =>
      path.basename(file) === "bad.txt" ? PromiseBB.reject(failure) : slow,
    );
    vi.stubGlobal("process", { ...process, platform: "win32" });
    vi.stubGlobal("Promise", runtime === "bluebird" ? PromiseBB : NativePromise);
    await h.method.prePurge("skyrimse");
    let settled = false;
    const result = Promise.resolve(h.method.purge(h.stagingDir, h.gameDir, "skyrimse")).then(
      () => {
        settled = true;
        return undefined;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    try {
      await vi.waitFor(() => expect(io.unlink).toHaveBeenCalledTimes(2));
      expect(settled).toBe(false);
    } finally {
      releaseSlow();
    }
    const error = await result;
    expect(error).toBe(failure);
    expect(io.unlink.mock.calls.map(([file]) => path.basename(file))).toEqual([
      "bad.txt",
      "slow.txt",
    ]);
  },
);

test.for(["native", "bluebird"] as const)(
  "Windows purge drains queued unlink work before a walker error with %s Promise",
  async (runtime, { makeDeployment }) => {
    const h = makeDeployment({ files: { "slow.txt": "slow" } });
    const scanError = Object.assign(new Error("directory scan failed"), { code: "EIO" });
    let releaseSlow: () => void;
    const held = new NativePromise<void>((resolve) => {
      releaseSlow = resolve;
    });
    io.walk.mockImplementation((root, callback) => {
      callback([{ filePath: path.join(root, "slow.txt"), linkCount: 2, idStr: "42" }]);
      return root === h.stagingDir ? PromiseBB.resolve() : PromiseBB.reject(scanError);
    });
    io.unlink.mockReturnValue(held);
    vi.stubGlobal("process", { ...process, platform: "win32" });
    vi.stubGlobal("Promise", runtime === "bluebird" ? PromiseBB : NativePromise);
    await h.method.prePurge("skyrimse");
    let settled = false;
    const result = Promise.resolve(h.method.purge(h.stagingDir, h.gameDir, "skyrimse")).then(
      () => {
        settled = true;
        return undefined;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    let beforeRelease: boolean;
    try {
      await vi.waitFor(() => expect(io.unlink).toHaveBeenCalledOnce());
      await new NativePromise((resolve) => setTimeout(resolve, 30));
      beforeRelease = settled;
    } finally {
      releaseSlow();
    }
    expect(await result).toBe(scanError);
    expect(beforeRelease).toBe(false);
  },
);

test("Windows purge still succeeds when all owned unlinks finish", async ({ makeDeployment }) => {
  const h = makeDeployment({ files: { "ok.txt": "ok" } });
  io.walk.mockImplementation((root, callback) => {
    callback([{ filePath: path.join(root, "ok.txt"), linkCount: 2, idStr: "42" }]);
    return PromiseBB.resolve();
  });
  io.unlink.mockResolvedValue(undefined);
  vi.stubGlobal("process", { ...process, platform: "win32" });
  await h.method.prePurge("skyrimse");
  await expect(h.method.purge(h.stagingDir, h.gameDir, "skyrimse")).resolves.toBeUndefined();
  expect(io.unlink).toHaveBeenCalledWith(path.join(h.gameDir, "ok.txt"));
});

test.for(["native", "bluebird"] as const)(
  "Windows purge does not mask an unlink failure with a missing walker root: %s Promise",
  async (runtime, { makeDeployment }) => {
    const h = makeDeployment({ files: { "blocked.txt": "owned" } });
    const failure = new UserCanceled();
    const missing = Object.assign(new Error("root disappeared"), { code: "ENOENT" });
    io.walk.mockImplementation((root, callback) => {
      callback([{ filePath: path.join(root, "blocked.txt"), linkCount: 2, idStr: "42" }]);
      return root === h.stagingDir ? PromiseBB.resolve() : PromiseBB.reject(missing);
    });
    io.unlink.mockRejectedValue(failure);
    vi.stubGlobal("process", { ...process, platform: "win32" });
    vi.stubGlobal("Promise", runtime === "bluebird" ? PromiseBB : NativePromise);
    await h.method.prePurge("skyrimse");
    await expect(h.method.purge(h.stagingDir, h.gameDir, "skyrimse")).rejects.toBe(failure);
    expect(io.unlink).toHaveBeenCalledOnce();
  },
);

test.for(["native", "bluebird"] as const)(
  "Windows purge stops later batches after cancellation with %s Promise",
  async (runtime, { makeDeployment }) => {
    const h = makeDeployment({ files: { "bad.txt": "bad", "later.txt": "later" } });
    const failure = new UserCanceled();
    const first = (root: string) => ({
      filePath: path.join(root, "bad.txt"),
      linkCount: 2,
      idStr: "42",
    });
    const later = (root: string) => ({
      filePath: path.join(root, "later.txt"),
      linkCount: 2,
      idStr: "43",
    });
    io.walk.mockImplementation((root, callback) => {
      if (root === h.stagingDir) callback([first(root), later(root)]);
      else {
        callback([first(root)]);
        callback([later(root)]);
      }
      return PromiseBB.resolve();
    });
    io.unlink.mockRejectedValue(failure);
    vi.stubGlobal("process", { ...process, platform: "win32" });
    vi.stubGlobal("Promise", runtime === "bluebird" ? PromiseBB : NativePromise);
    await h.method.prePurge("skyrimse");
    const error = await Promise.resolve(h.method.purge(h.stagingDir, h.gameDir, "skyrimse")).catch(
      (err: unknown) => err,
    );
    expect(io.unlink.mock.calls.map(([file]) => path.basename(file))).toEqual(["bad.txt"]);
    expect(error).toBe(failure);
  },
);

test.for(["native", "bluebird"] as const)(
  "Windows purge observes a failed batch while the walker continues with %s Promise",
  async (runtime, { makeDeployment }) => {
    const h = makeDeployment({ files: { "blocked.txt": "owned" } });
    const failure = Object.assign(new Error("early unlink failed"), { code: "EBUSY" });
    const nodeProcess = process;
    const unhandled = vi.fn();
    nodeProcess.on("unhandledRejection", unhandled);
    let finishWalk: () => void;
    const walking = new NativePromise<void>((resolve) => {
      finishWalk = resolve;
    });
    io.walk.mockImplementation((root, callback) => {
      callback([{ filePath: path.join(root, "blocked.txt"), linkCount: 2, idStr: "42" }]);
      return root === h.stagingDir ? PromiseBB.resolve() : walking;
    });
    io.unlink.mockRejectedValue(failure);
    vi.stubGlobal("process", { ...process, platform: "win32" });
    vi.stubGlobal("Promise", runtime === "bluebird" ? PromiseBB : NativePromise);
    try {
      await h.method.prePurge("skyrimse");
      const result = Promise.resolve(h.method.purge(h.stagingDir, h.gameDir, "skyrimse")).catch(
        (err: unknown) => err,
      );
      let earlyUnhandled: unknown[][];
      try {
        await vi.waitFor(() => expect(io.unlink).toHaveBeenCalledOnce());
        await new NativePromise((resolve) => setTimeout(resolve, 40));
        earlyUnhandled = unhandled.mock.calls.filter(([reason]) => reason === failure);
      } finally {
        finishWalk();
      }
      expect(await result).toBe(failure);
      expect(earlyUnhandled).toEqual([]);
    } finally {
      finishWalk?.();
      nodeProcess.off("unhandledRejection", unhandled);
    }
  },
);
