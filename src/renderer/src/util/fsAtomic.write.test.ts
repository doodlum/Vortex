import * as nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import PromiseBB from "bluebird";
import type * as tmp from "tmp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as utilFs from "./fs";

const fault = vi.hoisted(() => ({
  phase: undefined as "create" | "write" | "read" | "rename" | undefined,
  error: undefined as NodeJS.ErrnoException | undefined,
  badReads: 0,
  temps: [] as Array<{ path: string; fd: number; dev: bigint; ino: bigint }>,
  canaryPath: undefined as string | undefined,
  canaryFd: undefined as number | undefined,
  holdCleanup: false,
  cleanupError: undefined as Error | undefined,
  cleanupCompletions: [] as Array<() => void>,
}));

vi.mock("tmp", async (importOriginal) => {
  const actual = await importOriginal<typeof tmp>();
  const file = (options: tmp.FileOptions, callback: tmp.FileCallback) => {
    if (fault.phase === "create") return callback(fault.error, "", -1, () => {});
    actual.file(options, (error, name, fd, cleanup) => {
      if (!error) {
        const info = nodeFs.fstatSync(fd, { bigint: true });
        fault.temps.push({ path: name, fd, dev: info.dev, ino: info.ino });
      }
      const remove = cleanup as (next?: (err?: Error) => void) => void;
      const wrappedCleanup = (next?: (err?: Error) => void) => {
        const complete = (err?: Error) => {
          const finish = () => next?.(err);
          if (fault.holdCleanup) fault.cleanupCompletions.push(finish);
          else finish();
        };
        if (fault.cleanupError) complete(fault.cleanupError);
        else remove(complete);
      };
      callback(error, name, fd, wrappedCleanup);
    });
  };
  return { ...actual, file, default: { ...actual, file } };
});

vi.mock("./fs", async (importOriginal) => {
  const actual = await importOriginal<typeof utilFs>();
  const overrides = {
    writeAsync: (...args: Parameters<typeof actual.writeAsync>) =>
      fault.phase === "write" ? PromiseBB.reject(fault.error) : actual.writeAsync(...args),
    readFileAsync: (...args: Parameters<typeof actual.readFileAsync>) => {
      if (fault.phase === "read") return PromiseBB.reject(fault.error);
      if (fault.badReads-- > 0) return PromiseBB.resolve(Buffer.from("wrong checksum"));
      return actual.readFileAsync(...args);
    },
    renameAsync: (...args: Parameters<typeof actual.renameAsync>) => {
      if (fault.phase === "rename") return PromiseBB.reject(fault.error);
      return actual.renameAsync(...args).then(() => {
        if (fault.canaryPath) fault.canaryFd = nodeFs.openSync(fault.canaryPath, "wx");
      });
    },
  };
  return { ...actual, ...overrides, default: { ...actual, ...overrides } };
});

import { writeFileAtomic } from "./fsAtomic";

describe("writeFileAtomic resource ownership", () => {
  let dir: string;
  let destination: string;

  beforeEach(() => {
    dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), "fs-atomic-write-"));
    destination = path.join(dir, "manifest.json");
    nodeFs.writeFileSync(destination, "original");
    fault.phase = undefined;
    fault.error = undefined;
    fault.badReads = 0;
    fault.temps = [];
    fault.canaryPath = undefined;
    fault.canaryFd = undefined;
    fault.holdCleanup = false;
    fault.cleanupError = undefined;
    fault.cleanupCompletions = [];
  });

  afterEach(() => {
    // A failing baseline may leak a descriptor. Close only an inode this test created.
    for (const temp of fault.temps) {
      try {
        const info = nodeFs.fstatSync(temp.fd, { bigint: true });
        if (info.dev === temp.dev && info.ino === temp.ino) nodeFs.closeSync(temp.fd);
      } catch {
        // Already closed, including by the implementation under test.
      }
    }
    if (fault.canaryFd !== undefined) {
      try {
        const info = nodeFs.fstatSync(fault.canaryFd, { bigint: true });
        const canary = nodeFs.statSync(fault.canaryPath!, { bigint: true });
        if (info.dev === canary.dev && info.ino === canary.ino) nodeFs.closeSync(fault.canaryFd);
      } catch {
        // The descriptor-recycling regression may already have closed it.
      }
    }
    nodeFs.rmSync(dir, { recursive: true, force: true });
  });

  function fail(phase: typeof fault.phase, code = "EACCES") {
    fault.phase = phase;
    fault.error = Object.assign(new Error(`controlled ${phase} failure`), { code });
    return fault.error;
  }

  function noTemporaryFiles() {
    expect(nodeFs.readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  }

  it.each(["replacement", Buffer.from("replacement")])(
    "writes %s and closes its descriptor",
    async (input) => {
      await writeFileAtomic(destination, input);
      expect(nodeFs.readFileSync(destination, "utf8")).toBe("replacement");
      expect(fault.temps).toHaveLength(1);
      expect(() => nodeFs.fstatSync(fault.temps[0].fd)).toThrow();
      noTemporaryFiles();
    },
  );

  it("closes its descriptor when writing fails", async () => {
    const error = fail("write", "EDQUOT");
    await expect(writeFileAtomic(destination, "replacement")).rejects.toBe(error);
    expect(fault.temps).toHaveLength(1);
    expect(() => nodeFs.fstatSync(fault.temps[0].fd)).toThrow();
    expect(nodeFs.readFileSync(destination, "utf8")).toBe("original");
  });

  it("removes a failed write's temporary file before rejecting", async () => {
    const error = fail("write", "EDQUOT");
    await expect(writeFileAtomic(destination, "replacement")).rejects.toBe(error);
    expect(nodeFs.readFileSync(destination, "utf8")).toBe("original");
    noTemporaryFiles();
  });

  it("does not settle a failed write before the cleanup callback completes", async () => {
    const error = fail("write", "EDQUOT");
    fault.holdCleanup = true;
    let settled = false;
    const outcome = writeFileAtomic(destination, "replacement").then(
      () => {
        settled = true;
        return undefined;
      },
      (err) => {
        settled = true;
        return err;
      },
    );
    try {
      await vi.waitFor(() => expect(fault.cleanupCompletions).toHaveLength(1));
      expect(settled).toBe(false);
      fault.cleanupCompletions.shift()!();
      await expect(outcome).resolves.toBe(error);
    } finally {
      fault.holdCleanup = false;
      for (const finish of fault.cleanupCompletions.splice(0)) finish();
      await outcome;
    }
  });

  it("waits for old-attempt cleanup before creating a checksum retry", async () => {
    fault.badReads = 1;
    fault.holdCleanup = true;
    const outcome = writeFileAtomic(destination, "replacement");
    try {
      await vi.waitFor(() => expect(fault.cleanupCompletions).toHaveLength(1));
      expect(fault.temps).toHaveLength(1);
      fault.holdCleanup = false;
      fault.cleanupCompletions.shift()!();
      await outcome;
      expect(fault.temps).toHaveLength(2);
      noTemporaryFiles();
    } finally {
      fault.holdCleanup = false;
      for (const finish of fault.cleanupCompletions.splice(0)) finish();
      await outcome;
    }
  });

  it("preserves the original write error when cleanup also fails", async () => {
    const error = fail("write", "EDQUOT");
    fault.cleanupError = Object.assign(new Error("controlled cleanup failure"), { code: "EACCES" });
    await expect(writeFileAtomic(destination, "replacement")).rejects.toBe(error);
    expect(nodeFs.readFileSync(destination, "utf8")).toBe("original");
    expect(() => nodeFs.fstatSync(fault.temps[0].fd)).toThrow();
    expect(nodeFs.readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toHaveLength(1);
  });

  it.each(["read", "rename"] as const)(
    "cleans up after a %s failure without replacing the destination",
    async (phase) => {
      const error = fail(phase);
      await expect(writeFileAtomic(destination, "replacement")).rejects.toBe(error);
      expect(nodeFs.readFileSync(destination, "utf8")).toBe("original");
      noTemporaryFiles();
    },
  );

  it("removes the previous temporary file when a checksum retry succeeds", async () => {
    fault.badReads = 1;
    await writeFileAtomic(destination, "replacement");
    expect(fault.temps).toHaveLength(2);
    expect(nodeFs.readFileSync(destination, "utf8")).toBe("replacement");
    noTemporaryFiles();
  });

  it("cleans all four attempts when checksum verification never succeeds", async () => {
    fault.badReads = 10;
    await expect(writeFileAtomic(destination, "replacement")).rejects.toThrow("checksums differ");
    expect(fault.temps).toHaveLength(4);
    expect(nodeFs.readFileSync(destination, "utf8")).toBe("original");
    noTemporaryFiles();
  });

  it("does not close an unrelated file that reuses its released descriptor", async () => {
    fault.canaryPath = path.join(dir, "unrelated.txt");
    await writeFileAtomic(destination, "replacement");
    expect(fault.canaryFd).toBe(fault.temps[0].fd);
    expect(nodeFs.fstatSync(fault.canaryFd!).isFile()).toBe(true);
    nodeFs.writeSync(fault.canaryFd!, "unrelated canary");
    expect(nodeFs.readFileSync(fault.canaryPath, "utf8")).toBe("unrelated canary");
  });

  it("preserves a temporary-file creation error without changing the destination", async () => {
    const error = fail("create");
    await expect(writeFileAtomic(destination, "replacement")).rejects.toBe(error);
    expect(fault.temps).toEqual([]);
    expect(nodeFs.readFileSync(destination, "utf8")).toBe("original");
    noTemporaryFiles();
  });
});
