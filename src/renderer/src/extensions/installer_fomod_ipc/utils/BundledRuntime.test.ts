import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node-7z", () => ({ default: class {} }));
import { prepareNativeRuntime } from "./BundledRuntime";

const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "fomod-bundle-test-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function fixture(change?: (manifest: any) => void) {
  const assets = path.join(root, "assets");
  const cache = path.join(root, "cache");
  await fs.mkdir(assets);
  const contents = new Map<string, Buffer>();
  const entries = [
    "usr/bin/mono-sgen",
    "usr/bin/mcs",
    "usr/lib/mono/4.5/mcs.exe",
    "usr/lib/mono/4.5/mscorlib.dll",
    "usr/lib/libgdiplus.so.0",
    "etc/mono/config",
    "usr/lib/mono/4.5/System.dll",
    "licenses/duplicate",
    "licenses/different-mode",
  ].map((name, index) => {
    const bytes = Buffer.from(index >= 7 ? "fixture-1" : `fixture-${index}`);
    contents.set(hash(bytes), bytes);
    return {
      path: name,
      sha256: hash(bytes),
      bytes: bytes.length,
      mode: index === 0 || index === 1 || index === 8 ? 0o755 : 0o644,
    };
  });
  const manifest = {
    schemaVersion: 1,
    archiveLayout: "sha256-objects",
    platform: "linux",
    arch: "x64",
    entries,
  };
  change?.(manifest);
  const text = JSON.stringify(manifest);
  await fs.writeFile(path.join(assets, "runtime.json"), text);
  await fs.writeFile(path.join(assets, "runtime.zip"), "inert-archive-fixture");
  await fs.mkdir(path.join(assets, "helper"));
  await fs.writeFile(path.join(assets, "helper", "ModInstallerIPC.exe"), "helper-fixture");
  const pin = {
    archiveName: "runtime.zip",
    manifestName: "runtime.json",
    archiveSha256: hash("inert-archive-fixture"),
    manifestSha256: hash(text),
  };
  const extract = vi.fn(async (_archive: string, destination: string) => {
    await fs.mkdir(path.join(destination, "objects"));
    for (const [sha256, bytes] of contents)
      await fs.writeFile(path.join(destination, "objects", sha256), bytes);
  });
  return {
    assets,
    cache,
    pin,
    extract,
    manifest,
    contents,
    run: () => prepareNativeRuntime(assets, cache, pin, extract),
  };
}

// Real directory trees are created, hashed and renamed; on a loaded Windows host the default 5s is too tight.
describe("bundled native C# runtime preparation", { timeout: 30_000 }, () => {
  it("materializes verified objects, preserves modes and reuses a verified cache", async () => {
    const f = await fixture();
    const runtime = await f.run();
    expect(runtime.helper).toBe(path.join(f.assets, "helper", "ModInstallerIPC.exe"));
    expect(await fs.readFile(runtime.helper, "utf8")).toBe("helper-fixture");
    expect(await fs.readFile(path.join(runtime.root, "usr/bin/mcs"), "utf8")).toBe("fixture-1");
    const executable = await fs.stat(path.join(runtime.root, "usr/bin/mcs"));
    const regular = await fs.stat(path.join(runtime.root, "licenses/duplicate"));
    const duplicate = await fs.stat(path.join(runtime.root, "licenses/different-mode"));
    expect(executable.ino).toBe(duplicate.ino);
    expect(executable.ino).not.toBe(regular.ino);
    if (process.platform !== "win32") {
      expect(executable.mode & 0o7777).toBe(0o755);
      expect(regular.mode & 0o7777).toBe(0o644);
    }
    expect(await f.run()).toEqual(runtime);
    expect(f.extract).toHaveBeenCalledOnce();
    expect((await fs.readdir(f.cache)).some((file) => file.startsWith(".stage-"))).toBe(false);
  });
  it("coalesces simultaneous setup calls", async () => {
    const f = await fixture();
    const [a, b] = await Promise.all([f.run(), f.run()]);
    expect(a).toEqual(b);
    expect(f.extract).toHaveBeenCalledOnce();
  });
  it("refuses a build without the helper before extraction", async () => {
    const f = await fixture();
    await fs.rm(path.join(f.assets, "helper"), { recursive: true });
    await expect(f.run()).rejects.toThrow("helper is missing");
    expect(f.extract).not.toHaveBeenCalled();
  });
  it("retains and automatically replaces a corrupted cached runtime file", async () => {
    const f = await fixture();
    const initial = await f.run();
    const library = (root: string) => path.join(root, "usr/lib/mono/4.5/System.dll");
    await fs.writeFile(library(initial.root), "corrupted");
    const replacement = await f.run();
    expect(await fs.readFile(library(replacement.root), "utf8")).toBe("fixture-6");
    expect(f.extract).toHaveBeenCalledTimes(2);
    const quarantined = (await fs.readdir(f.cache)).find((name) => name.includes(".invalid-"));
    expect(quarantined).toBeDefined();
    expect(
      await fs.readFile(path.join(f.cache, quarantined!, "usr/lib/mono/4.5/System.dll"), "utf8"),
    ).toBe("corrupted");
  });
  it("rejects altered archive bytes before invoking the extractor", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.assets, "runtime.zip"), "changed");
    await expect(f.run()).rejects.toThrow("archive checksum");
    expect(f.extract).not.toHaveBeenCalled();
  });
  it("rejects altered metadata before creating the cache", async () => {
    const f = await fixture();
    await fs.appendFile(path.join(f.assets, "runtime.json"), " ");
    await expect(f.run()).rejects.toThrow("manifest checksum");
    await expect(fs.stat(f.cache)).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.extract).not.toHaveBeenCalled();
  });
  it.each(["../escape", "/absolute", "C:/drive", "wrapper\\escape", "a/./b", "a//b", "a/../b"])(
    "refuses manifest path %s before extraction",
    async (relative) => {
      const f = await fixture((m) => {
        m.entries[0].path = relative;
      });
      await expect(f.run()).rejects.toThrow("bundle entry");
      expect(f.extract).not.toHaveBeenCalled();
    },
  );
  it.each(["duplicate", "missing", "privileged", "oversized", "bad-hash"])(
    "rejects %s metadata before extraction",
    async (kind) => {
      const f = await fixture((m) => {
        if (kind === "duplicate") m.entries.push(m.entries[0]);
        if (kind === "missing") m.entries.shift();
        if (kind === "privileged") m.entries[0].mode = 0o4755;
        if (kind === "oversized") m.entries[0].bytes = 65 * 1024 * 1024;
        if (kind === "bad-hash") m.entries[0].sha256 = "not-a-digest";
      });
      await expect(f.run()).rejects.toThrow();
      expect(f.extract).not.toHaveBeenCalled();
    },
  );
  it.each(["missing", "extra", "changed"])(
    "rejects %s extracted objects and clears staging",
    async (kind) => {
      const f = await fixture();
      const original = f.extract.getMockImplementation()!;
      f.extract.mockImplementation(async (archive, destination) => {
        await original(archive, destination);
        const first = [...f.contents.keys()][0];
        if (kind === "missing") await fs.unlink(path.join(destination, "objects", first));
        if (kind === "extra")
          await fs.writeFile(path.join(destination, "objects", "0".repeat(64)), "extra");
        if (kind === "changed")
          await fs.writeFile(path.join(destination, "objects", first), "changed");
      });
      await expect(f.run()).rejects.toThrow();
      expect(await fs.readdir(f.cache)).toEqual([]);
    },
  );
  it("cleans a failed extraction and permits a later retry", async () => {
    const f = await fixture();
    f.extract.mockRejectedValueOnce(new Error("inert extractor failure"));
    await expect(f.run()).rejects.toThrow("inert extractor failure");
    expect(await fs.readdir(f.cache)).toEqual([]);
    await expect(f.run()).resolves.toHaveProperty("helper");
  });
  it("refuses a cache target link without touching its destination", async () => {
    const f = await fixture();
    const outside = path.join(root, "outside");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "sentinel"), "preserve");
    await fs.mkdir(f.cache);
    await fs.symlink(
      outside,
      path.join(f.cache, f.pin.manifestSha256),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(f.run()).rejects.toThrow("cache target");
    expect(await fs.readFile(path.join(outside, "sentinel"), "utf8")).toBe("preserve");
    expect(f.extract).not.toHaveBeenCalled();
  });
  it("replaces a linked directory inside a damaged cache without following it", async () => {
    const f = await fixture();
    const runtime = await f.run();
    const outside = path.join(root, "outside");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "sentinel"), "preserve");
    await fs.rm(path.join(runtime.root, "licenses"), { recursive: true });
    await fs.symlink(
      outside,
      path.join(runtime.root, "licenses"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const replacement = await f.run();
    expect(await fs.readFile(path.join(replacement.root, "licenses/duplicate"), "utf8")).toBe(
      "fixture-1",
    );
    expect(await fs.readdir(outside)).toEqual(["sentinel"]);
    expect(await fs.readFile(path.join(outside, "sentinel"), "utf8")).toBe("preserve");
  });
});
