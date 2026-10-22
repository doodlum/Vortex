import * as path from "node:path";
import { setImmediate } from "node:timers/promises";

import { beforeEach, expect, it, vi } from "vitest";

import { purgeNativeHardlinks } from "./nativeHardlinks";

const io = vi.hoisted(() => ({ readdir: vi.fn(), lstat: vi.fn(), unlink: vi.fn() }));
vi.mock("node:fs/promises", () => ({ ...io, default: io }));

const staging = path.resolve("staging");
const game = path.resolve("game");
const entry = (name: string) => ({ name, isDirectory: () => false, isFile: () => true });
const stats = (ino: bigint, dev = 1n) => ({ ino, dev, nlink: 2n, isFile: () => true });

beforeEach(() => {
  vi.resetAllMocks();
  io.readdir.mockImplementation(async (directory: string) => [
    entry(directory === staging ? "source" : "output"),
  ]);
  io.unlink.mockResolvedValue(undefined);
});

it.each([
  { label: "different devices", source: stats(42n, 1n), output: stats(42n, 2n) },
  {
    label: "distinct inodes above Number.MAX_SAFE_INTEGER",
    source: stats(9007199254740992n),
    output: stats(9007199254740993n),
  },
])("preserves an unrelated hardlink with $label", async ({ source, output }) => {
  io.lstat.mockImplementation(async (file: string) =>
    path.dirname(file) === staging ? source : output,
  );
  await purgeNativeHardlinks(staging, game);
  expect(io.unlink).not.toHaveBeenCalled();
});

it("tolerates a destination disappearing before its identity can be read", async () => {
  io.lstat.mockImplementation(async (file: string) => {
    if (path.dirname(file) === game) throw Object.assign(new Error("gone"), { code: "ENOENT" });
    return stats(1n);
  });
  await expect(purgeNativeHardlinks(staging, game)).resolves.toBeUndefined();
  expect(io.unlink).not.toHaveBeenCalled();
});

it("drains a pending filesystem operation before reporting another operation's failure", async () => {
  io.readdir.mockResolvedValue([entry("bad"), entry("pending")]);
  const failure = Object.assign(new Error("permission denied"), { code: "EACCES" });
  let finishPending!: (value: ReturnType<typeof stats>) => void;
  const pending = new Promise<ReturnType<typeof stats>>((resolve) => {
    finishPending = resolve;
  });
  io.lstat.mockImplementation(async (file: string) => {
    if (path.basename(file) === "bad") throw failure;
    return pending;
  });
  let settled = false;
  const result = purgeNativeHardlinks(staging, game).then(
    () => {
      settled = true;
      return undefined;
    },
    (err: unknown) => {
      settled = true;
      return err;
    },
  );
  try {
    await vi.waitFor(() => expect(io.lstat).toHaveBeenCalledTimes(2));
    await setImmediate();
    expect(settled).toBe(false);
  } finally {
    finishPending(stats(1n));
  }
  const error = await result;
  expect(error).toBeInstanceOf(AggregateError);
  expect((error as AggregateError).errors).toEqual([failure]);
  expect(io.unlink).not.toHaveBeenCalled();
});
