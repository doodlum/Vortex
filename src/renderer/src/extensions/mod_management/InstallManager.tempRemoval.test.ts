import * as nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import InstallManager from "./InstallManager";
import PriorityLimiter from "./util/PriorityLimiter";

// The temporary install directory is removed in the background once the install is done. An
// install into the same path (a reinstall, or a retry of a failed member) must not extract into it
// while that removal still runs, or the removal deletes the files it just extracted.
const proto = InstallManager.prototype as any;
const roots: string[] = [];

function makeSelf() {
  return {
    mExtractLimit: new PriorityLimiter(5),
    mTempRemovals: new Map<string, Promise<void>>(),
    awaitTempRemoval: proto.awaitTempRemoval,
    removeTempInBackground: proto.removeTempInBackground,
    isFileInUse: () => false,
    isCritical: () => false,
  };
}

function tempDir(): string {
  const root = nodeFs.mkdtempSync(path.join(os.tmpdir(), "vortex-temp-removal-"));
  roots.push(root);
  const dir = path.join(root, "mod.installing");
  nodeFs.mkdirSync(path.join(dir, "sub"), { recursive: true });
  nodeFs.writeFileSync(path.join(dir, "sub", "old.txt"), "old");
  return dir;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    nodeFs.rmSync(root, { recursive: true, force: true });
  }
});

describe("background removal of the temporary install directory", () => {
  it("removes the directory and forgets it once done", async () => {
    const self = makeSelf();
    const dir = tempDir();
    proto.removeTempInBackground.call(self, dir);
    expect(self.mTempRemovals.size).toBe(1);
    await self.mTempRemovals.get(dir.toLowerCase());
    expect(nodeFs.existsSync(dir)).toBe(false);
    expect(self.mTempRemovals.size).toBe(0);
  });

  it("an extraction into the same path waits for the removal", async () => {
    const self = makeSelf();
    const dir = tempDir();
    let release: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    self.mTempRemovals.set(dir.toLowerCase(), pending);
    let extracted = false;
    const zip = {
      extractFull: (_archive: string, dest: string) => {
        extracted = true;
        nodeFs.mkdirSync(dest, { recursive: true });
        nodeFs.writeFileSync(path.join(dest, "new.txt"), "new");
        return Promise.resolve({ code: 0, errors: [] });
      },
    };
    const extraction = proto.extractWithRetry.call(
      self,
      zip,
      "archive.7z",
      dir,
      () => undefined,
      () => Promise.resolve(""),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(extracted).toBe(false);
    release();
    await extraction;
    expect(extracted).toBe(true);
    expect(nodeFs.readdirSync(dir)).toEqual(["new.txt"]);
  });

  it("queues removals of one path behind each other", async () => {
    const self = makeSelf();
    const dir = tempDir();
    proto.removeTempInBackground.call(self, dir);
    const first = self.mTempRemovals.get(dir.toLowerCase());
    proto.removeTempInBackground.call(self, dir);
    const second = self.mTempRemovals.get(dir.toLowerCase());
    expect(second).not.toBe(first);
    await second;
    expect(self.mTempRemovals.size).toBe(0);
    expect(nodeFs.existsSync(dir)).toBe(false);
  });
});
