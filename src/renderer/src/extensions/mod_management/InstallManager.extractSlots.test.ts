import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import InstallManager from "./InstallManager";
import PriorityLimiter from "./util/PriorityLimiter";

// Extraction has its own slots: an install holds one only while 7z runs, so the work around
// extraction (file list, installer, linking) never keeps another archive from extracting.

function harness(extractSlots: number) {
  let running = 0;
  let peak = 0;
  const started: string[] = [];
  const finish = new Map<string, () => void>();
  const zip = {
    extractFull: (archivePath: string) => {
      started.push(path.basename(archivePath));
      ++running;
      peak = Math.max(peak, running);
      return new Promise((resolve) => {
        finish.set(path.basename(archivePath), () => {
          --running;
          resolve({ code: 0, errors: [] });
        });
      });
    },
  };
  const self = {
    mExtractLimit: new PriorityLimiter(extractSlots),
    isFileInUse: () => false,
    isCritical: () => false,
  };
  const extract = (name: string, priority?: number) =>
    (InstallManager.prototype as any).extractWithRetry.call(
      self,
      zip,
      name,
      path.join(os.tmpdir(), `vortex-extract-slots-${process.pid}`, `${name}.installing`),
      () => undefined,
      () => Promise.resolve(""),
      priority,
    );
  return { extract, started, finish, peak: () => peak };
}

describe("extraction slots", () => {
  it("run at most the extraction limit of 7z processes, largest archive first", async () => {
    const h = harness(2);
    const all = [
      h.extract("a", 10),
      h.extract("b", 20),
      h.extract("c", 30),
      h.extract("d", 40),
      h.extract("direct"),
    ];
    await vi.waitFor(() => expect(h.started).toEqual(["a", "b"]));
    h.finish.get("a")!();
    // a directly started install goes ahead of dependencies, then the largest waiting archive
    await vi.waitFor(() => expect(h.started).toEqual(["a", "b", "direct"]));
    h.finish.get("b")!();
    h.finish.get("direct")!();
    await vi.waitFor(() => expect(h.started).toEqual(["a", "b", "direct", "d", "c"]));
    h.finish.get("d")!();
    h.finish.get("c")!();
    await Promise.all(all);
    expect(h.peak()).toBe(2);
  });

  it("allows more installs in flight than extractions", () => {
    expect((InstallManager as any).INSTALL_SLOTS).toBeGreaterThan(
      InstallManager.MAX_SIMULTANEOUS_INSTALLS,
    );
  });
});
