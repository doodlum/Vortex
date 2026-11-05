import * as nodeFs from "node:fs";
import * as path from "node:path";

import { InsufficientDiskSpace } from "@vortex/shared/errors";
import Zip from "node-7z";
import { afterEach, describe, expect, it, vi } from "vitest";

import InstallManager from "./InstallManager";

vi.mock("../../logging", () => ({ log: vi.fn() }));
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof nodeFs>()),
  statfsSync: vi.fn(),
}));

interface ExtractionBoundary {
  extractWithRetry: ReturnType<typeof vi.fn>;
  queryContinue: ReturnType<typeof vi.fn>;
  installInner(...args: unknown[]): Promise<unknown>;
  simulate(...args: unknown[]): Promise<unknown>;
}

describe.each(["install", "simulate"])("%s extraction storage failures", (mode) => {
  const tempPath = path.resolve("private-volume", "Staging", "second.installing");
  const archivePrompt = new Error("archive prompt sentinel");

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetAllMocks();
  });

  function manager(errors: string[], code = 2) {
    const value = Object.create(InstallManager.prototype) as ExtractionBoundary;
    value.extractWithRetry = vi.fn().mockResolvedValue({ code, errors });
    value.queryContinue = vi.fn().mockRejectedValue(archivePrompt);
    vi.spyOn(Zip.prototype, "extractFull").mockResolvedValue({ code, errors });
    return value;
  }

  function install(value: ExtractionBoundary) {
    return mode === "simulate"
      ? value.simulate({}, "fixture", "second.zip", tempPath)
      : value.installInner({}, "second.zip", tempPath, "destination", "fixture", undefined, {});
  }

  it.each([["Cannot create output directory : errno=17 : File exists"], []])(
    "reports full target storage despite ambiguous extractor output %j",
    async (...messages) => {
      vi.mocked(nodeFs.statfsSync).mockReturnValue({ bavail: 0, bsize: 4096 } as nodeFs.StatsFs);
      const value = manager(messages);
      await expect(install(value)).rejects.toBeInstanceOf(InsufficientDiskSpace);
      expect(value.queryContinue).not.toHaveBeenCalled();
      expect(nodeFs.statfsSync).toHaveBeenCalledWith(path.dirname(tempPath));
    },
  );

  it.each(["No space left on device", "not enough space", "ENOSPC", "errno=28 : device full"])(
    "recognizes storage diagnostics %s even when capacity cannot be queried",
    async (message) => {
      vi.mocked(nodeFs.statfsSync).mockImplementation(() => {
        throw new Error("probe unavailable");
      });
      const value = manager([message]);
      await expect(install(value)).rejects.toBeInstanceOf(InsufficientDiskSpace);
      expect(value.queryContinue).not.toHaveBeenCalled();
    },
  );

  it.each(["space available", "probe unavailable"])(
    "keeps ambiguous extraction errors on the archive path when %s",
    async (probe) => {
      if (probe === "space available") {
        vi.mocked(nodeFs.statfsSync).mockReturnValue({ bavail: 12, bsize: 4096 } as nodeFs.StatsFs);
      } else {
        vi.mocked(nodeFs.statfsSync).mockImplementation(() => {
          throw new Error("unavailable");
        });
      }
      const value = manager(["Cannot create output directory : errno=17 : File exists"]);
      await expect(install(value)).rejects.toBe(archivePrompt);
      expect(value.queryContinue).toHaveBeenCalledOnce();
    },
  );

  it("keeps confirmed corruption diagnostic precedence on a full target", async () => {
    vi.mocked(nodeFs.statfsSync).mockReturnValue({ bavail: 0, bsize: 4096 } as nodeFs.StatsFs);
    const value = manager(["Unexpected end of archive"]);
    await expect(install(value)).rejects.not.toBeInstanceOf(InsufficientDiskSpace);
    expect(value.queryContinue).not.toHaveBeenCalled();
  });
});
