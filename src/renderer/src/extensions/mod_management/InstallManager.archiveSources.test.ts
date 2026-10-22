import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import PromiseBB from "bluebird";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { IExtensionApi } from "../../types/api";
import * as wrappedFs from "../../util/fs";
import InstallManager from "./InstallManager";
import type { IInstruction } from "./types/IInstallResult";

vi.mock("../../logging", () => ({ log: vi.fn() }));

interface SourceCopyBoundary {
  transformInstructions(input: IInstruction[]): { copy: IInstruction[] };
  extractArchive(
    api: IExtensionApi,
    archive: string,
    source: string,
    destination: string,
    copies: IInstruction[],
    game: string,
  ): Promise<void>;
}

describe("installer archive sources", () => {
  const roots: string[] = [];
  const manager = Object.create(InstallManager.prototype) as SourceCopyBoundary;
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function fixture() {
    const root = await mkdtemp(path.join(os.tmpdir(), "vortex-archive-sources-"));
    roots.push(root);
    const source = path.join(root, "archive");
    const destination = path.join(root, "staged");
    await mkdir(path.join(source, "Assets", "Meshes"), { recursive: true });
    await writeFile(path.join(source, "Assets", "Meshes", "Example.BIN"), "mesh payload");
    await writeFile(path.join(source, "Assets", "Config.txt"), "config payload");
    const showErrorNotification = vi.fn();
    const api = {
      showErrorNotification,
      translate: (text: string) => text,
    } as unknown as IExtensionApi;
    return { source, destination, api, showErrorNotification };
  }

  it("copies real native FOMOD instructions with Windows spelling into identical physical files", async () => {
    const f = await fixture();
    // Produced by the same XML fixture on the released Windows native installer
    // and the Linux native backend; both preserve the XML's file-source case.
    const instructions: IInstruction[] = [
      { type: "copy", source: "assets\\CONFIG.TXT", destination: "Settings\\Options.INI" },
      { type: "copy", source: "Assets\\Meshes\\Example.BIN", destination: "Meshes\\Example.BIN" },
    ];
    await manager.extractArchive(
      f.api,
      "fixture.zip",
      f.source,
      f.destination,
      manager.transformInstructions(instructions).copy,
      "game",
    );
    expect(await readFile(path.join(f.destination, "Settings", "Options.INI"), "utf8")).toBe(
      "config payload",
    );
    expect(await readFile(path.join(f.destination, "Meshes", "Example.BIN"), "utf8")).toBe(
      "mesh payload",
    );
    expect(f.showErrorNotification).not.toHaveBeenCalled();
  });

  it("reports genuinely missing archive sources", async () => {
    const f = await fixture();
    await manager.extractArchive(
      f.api,
      "fixture.zip",
      f.source,
      f.destination,
      [{ type: "copy", source: "missing.txt", destination: "missing.txt" }],
      "game",
    );
    expect(f.showErrorNotification).toHaveBeenCalledOnce();
  });

  it("propagates a failed copy fallback instead of reporting a successful empty install", async () => {
    const f = await fixture();
    const failure = Object.assign(new Error("copy permission denied"), { code: "EACCES" });
    vi.spyOn(wrappedFs, "linkAsync").mockRejectedValue(
      Object.assign(new Error("cross device"), { code: "EXDEV" }),
    );
    vi.spyOn(wrappedFs, "copyAsync").mockRejectedValue(failure);
    await expect(
      manager.extractArchive(
        f.api,
        "fixture.zip",
        f.source,
        f.destination,
        [{ type: "copy", source: "Assets/Config.txt", destination: "Options.INI" }],
        "game",
      ),
    ).rejects.toBe(failure);
  });
  it("drains accepted transfers and stops queued I/O before rejecting a failed fallback", async () => {
    const f = await fixture();
    const concurrency = Math.min(256, Math.max(8, os.cpus().length * 8));
    const failure = Object.assign(new Error("copy permission denied"), { code: "EACCES" });
    vi.spyOn(wrappedFs, "linkAsync").mockRejectedValue(
      Object.assign(new Error("cross device"), { code: "EXDEV" }),
    );
    const originalCopy = wrappedFs.copyAsync;
    let releasePeers!: () => void;
    const gate = new Promise<void>((resolve) => {
      releasePeers = resolve;
    });
    const pending: PromiseLike<unknown>[] = [];
    const copy = vi.spyOn(wrappedFs, "copyAsync").mockImplementation((source, destination) => {
      if (path.basename(destination) === "file-000.ini") return PromiseBB.reject(failure);
      const work = PromiseBB.resolve(gate).then(() => originalCopy(source, destination));
      pending.push(work);
      return work;
    });
    let settled = false;
    let rejected: unknown;
    const extracting = manager
      .extractArchive(
        f.api,
        "fixture.zip",
        f.source,
        f.destination,
        Array.from({ length: concurrency + 2 }, (_, index) => ({
          type: "copy" as const,
          source: "Assets/Config.txt",
          destination: "file-" + String(index).padStart(3, "0") + ".ini",
        })),
        "game",
      )
      .then(
        () => {
          settled = true;
        },
        (error: unknown) => {
          settled = true;
          rejected = error;
        },
      );
    try {
      await vi.waitFor(() => expect(copy).toHaveBeenCalledTimes(concurrency));
      expect(settled, "extraction must retain ownership until accepted peer writes finish").toBe(
        false,
      );
      releasePeers();
      await extracting;
      expect(rejected).toBe(failure);
      expect(copy).toHaveBeenCalledTimes(concurrency);
      expect(await readFile(path.join(f.destination, "file-001.ini"), "utf8")).toBe(
        "config payload",
      );
      await expect(
        readFile(path.join(f.destination, "file-" + String(concurrency).padStart(3, "0") + ".ini")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      releasePeers();
      await extracting;
      // A failing control can return before its pool; drain it before fixture removal.
      await new Promise<void>((resolve) => setImmediate(resolve));
      let drained = -1;
      while (drained !== pending.length) {
        drained = pending.length;
        await Promise.all(pending);
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
  });
});
