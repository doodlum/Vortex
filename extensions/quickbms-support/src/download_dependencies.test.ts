import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  prepareQuickBms,
  extractExecutable,
  selectArtifact,
  downloadBytes,
} = require("../download_dependencies.js");
const SevenZip = require("node-7z");
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "quickbms-download-test-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

interface InertResponse {
  ok: boolean;
  status: number;
  body: AsyncIterable<Buffer> | null;
}

function fixture(platform = "linux") {
  const archive = Buffer.from("inert pinned archive fixture");
  const executable = Buffer.from("inert executable fixture; never executed");
  const asset = (name: string) => ({
    url: "https://fixture.invalid/quickbms.zip",
    executable: name,
    archiveSha256: sha(archive),
    executableSha256: sha(executable),
  });
  const pins = { linux: asset("quickbms_4gb_files"), win32: asset("quickbms_4gb_files.exe") };
  const fetcher = vi.fn<() => Promise<InertResponse>>(async () => ({
    ok: true,
    status: 200,
    body: (async function* () {
      yield archive;
    })(),
  }));
  const extracted: string[] = [];
  const extract = vi.fn<(input: string, destination: string, name: string) => Promise<void>>(
    async (input, destination, name) => {
      expect(await fs.readFile(input)).toEqual(archive);
      extracted.push(destination);
      await fs.writeFile(path.join(destination, name), executable);
    },
  );
  const dist = path.join(root, "dist");
  return {
    archive,
    executable,
    pins,
    fetcher,
    extract,
    extracted,
    dist,
    output: path.join(dist, platform === "linux" ? pins.linux.executable : pins.win32.executable),
    run: () =>
      prepareQuickBms({
        platform,
        arch: "x64",
        dist,
        pins,
        fetcher,
        extract,
        retry: { retryDelayMs: 0 },
      }),
  };
}

describe("pinned QuickBMS build assets", () => {
  it.each(["linux", "win32"])(
    "publishes %s bytes and reuses a verified cache without network",
    async (platform) => {
      const f = fixture(platform);
      await fs.mkdir(f.dist);
      const other = path.join(
        f.dist,
        platform === "linux" ? "quickbms_4gb_files.exe" : "quickbms_4gb_files",
      );
      await fs.writeFile(other, "stale opposing-platform asset");
      expect(await f.run()).toBe(f.output);
      expect(await fs.readFile(f.output)).toEqual(f.executable);
      await expect(fs.stat(other)).rejects.toMatchObject({ code: "ENOENT" });
      f.fetcher.mockImplementation(async () => {
        throw new Error("network must not be used");
      });
      expect(await f.run()).toBe(f.output);
      expect(f.fetcher).toHaveBeenCalledOnce();
      expect(f.extract).toHaveBeenCalledOnce();
      await Promise.all(
        f.extracted.map((destination) =>
          expect(fs.stat(path.dirname(destination))).rejects.toMatchObject({ code: "ENOENT" }),
        ),
      );
    },
  );
  it.skipIf(process.platform === "win32")(
    "marks the native Linux executable runnable",
    async () => {
      const f = fixture();
      await f.run();
      expect((await fs.stat(f.output)).mode & 0o777).toBe(0o755);
    },
  );
  it("automatically replaces a corrupted cached executable", async () => {
    const f = fixture();
    await f.run();
    await fs.writeFile(f.output, "corrupted");
    await f.run();
    expect(await fs.readFile(f.output)).toEqual(f.executable);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(f.extract).toHaveBeenCalledTimes(2);
  });
  it("refuses a failed HTTP response before extraction or publication", async () => {
    const f = fixture();
    f.fetcher.mockResolvedValue({ ok: false, status: 403, body: null });
    await expect(f.run()).rejects.toThrow("download failed (403)");
    expect(f.extract).not.toHaveBeenCalled();
    await expect(fs.stat(f.output)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("tries a failed connection or a server error again", async () => {
    const f = fixture();
    const good = await f.fetcher();
    f.fetcher
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce({ ok: false, status: 503, body: null })
      .mockResolvedValueOnce(good);
    const retry = { attempts: 3, retryDelayMs: 0 };
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await prepareQuickBms({ platform: "linux", arch: "x64", ...f, retry });
    expect(await fs.readFile(f.output)).toEqual(f.executable);
    expect(f.fetcher).toHaveBeenCalledTimes(4);
  });
  it("gives up after the last attempt and on a refusal", async () => {
    const f = fixture();
    const retry = { attempts: 2, retryDelayMs: 0 };
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    f.fetcher.mockRejectedValue(new TypeError("fetch failed"));
    await expect(prepareQuickBms({ platform: "linux", arch: "x64", ...f, retry })).rejects.toThrow(
      "fetch failed",
    );
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    f.fetcher.mockReset().mockResolvedValue({ ok: false, status: 404, body: null });
    await expect(prepareQuickBms({ platform: "linux", arch: "x64", ...f, retry })).rejects.toThrow(
      "download failed (404)",
    );
    expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it("rejects changed archive bytes before invoking the extractor, after trying again", async () => {
    const f = fixture();
    f.pins.linux.archiveSha256 = "0".repeat(64);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(f.run()).rejects.toThrow("archive checksum");
    expect(f.fetcher).toHaveBeenCalledTimes(3);
    expect(f.extract).not.toHaveBeenCalled();
  });
  it("downloads again after bytes cut short", async () => {
    const f = fixture();
    const good = await f.fetcher();
    f.fetcher
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: (async function* () {
          yield f.archive.subarray(0, 5);
        })(),
      })
      .mockResolvedValueOnce(good);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await f.run();
    expect(await fs.readFile(f.output)).toEqual(f.executable);
    expect(f.fetcher).toHaveBeenCalledTimes(3);
  });
  it("retains an existing invalid cache when downloaded executable verification fails", async () => {
    const f = fixture();
    await fs.mkdir(f.dist);
    await fs.writeFile(f.output, "old invalid cache");
    f.extract.mockImplementation(async (_input: string, destination: string, name: string) => {
      await fs.writeFile(path.join(destination, name), "changed executable");
    });
    await expect(f.run()).rejects.toThrow("executable checksum");
    expect(await fs.readFile(f.output, "utf8")).toBe("old invalid cache");
    expect(await fs.readdir(f.dist)).toEqual(["quickbms_4gb_files"]);
  });
  it("propagates extractor failure without publishing a partial executable", async () => {
    const f = fixture();
    f.extract.mockRejectedValue(new Error("fixture extraction failed"));
    await expect(f.run()).rejects.toThrow("fixture extraction failed");
    expect(await fs.readdir(f.dist)).toEqual([]);
  });
  it("refuses an executable cache link without touching its destination", async () => {
    const f = fixture();
    await fs.mkdir(f.dist);
    const outside = path.join(root, "outside");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "sentinel"), "preserve");
    await fs.symlink(outside, f.output, process.platform === "win32" ? "junction" : "dir");
    await expect(f.run()).rejects.toThrow("regular file");
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(await fs.readdir(outside)).toEqual(["sentinel"]);
    expect(await fs.readFile(path.join(outside, "sentinel"), "utf8")).toBe("preserve");
  });
  it("treats the 7-Zip wrapper's nonzero resolved exit as failure", async () => {
    vi.spyOn(SevenZip.prototype, "extract").mockResolvedValue({ code: 2, errors: [] });
    await expect(extractExecutable("fixture.zip", "output", "quickbms_4gb_files")).rejects.toThrow(
      "extraction failed (2)",
    );
  });
  it.each([
    ["linux", "arm64"],
    ["darwin", "x64"],
  ])("refuses unsupported %s/%s before downloading", (platform, arch) => {
    expect(() => selectArtifact(platform, arch)).toThrow("no bundled runtime");
  });
  it("bounds response bytes and closes a rejected response iterator", async () => {
    let closed = false;
    const fetcher = async () => ({
      ok: true,
      status: 200,
      body: (async function* () {
        try {
          for (let i = 0; i < 9; i++) yield Buffer.alloc(4 * 1024 * 1024);
        } finally {
          closed = true;
        }
      })(),
    });
    await expect(downloadBytes("https://fixture.invalid/oversized.zip", fetcher)).rejects.toThrow(
      "size limit",
    );
    expect(closed).toBe(true);
  });
});
