import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { describe, expect, it } from "vitest";

import {
  clearModShaderCache,
  inspectModShaderCache,
  inspectPrivateShaderCache,
} from "./shaderCache";

describe("mod shader cache", () => {
  it("does not claim an empty private cache matches an unavailable or malformed Steam source", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vortex-missing-shaders-"));
    try {
      const app = path.join(root, "22380");
      const source = path.join(root, "missing", "22380");
      const marker = path.join(app, ".vortex-steam-source.json");
      await fs.mkdir(app);
      await fs.writeFile(
        marker,
        JSON.stringify({ version: 1, appId: "22380", fingerprint: "a".repeat(64), source }),
      );
      expect(await inspectPrivateShaderCache(root, "22380", [source])).toMatchObject({
        matchesSteam: false,
        totalFiles: 0,
      });
      await fs.mkdir(source, { recursive: true });
      await fs.writeFile(
        marker,
        JSON.stringify({ version: 1, appId: "22380", fingerprint: "invalid", source }),
      );
      expect(await inspectPrivateShaderCache(root, "22380", [source])).toMatchObject({
        matchesSteam: false,
        totalFiles: 0,
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it("clears generated cache while preserving Steam-owned databases and downloads", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vortex-shaders-"));
    const app = path.join(root, "22380");
    const generated = [
      path.join(app, "DXVK_state_cache", "FalloutNV.dxvk-cache"),
      path.join(app, "fozpipelinesv6", "steamapprun_pipeline_cache.abc", "cache.foz"),
      path.join(app, "mesa_shader_cache_sf", "driver", "GPU", "foz_cache.foz"),
      path.join(app, "mesa_shader_cache_sf", "driver", "GPU", "foz_cache_idx.foz"),
      path.join(app, "dxvk", "FalloutNV.dxvk-cache"),
      path.join(app, "amd_vk_pipeline_cache.bin"),
      path.join(app, "nvidia", "GLCache", "entry.bin"),
    ];
    const preserved = [
      path.join(app, "mesa_shader_cache_sf", "driver", "GPU", "steam_cache.foz"),
      path.join(app, "mesa_shader_cache_sf", "driver", "GPU", "steam_precompiled.foz"),
      path.join(app, "downloads", "mesa_shader_cache_sf", "driver", "GPU", "steam_cache.foz"),
    ];
    for (const file of [...generated, ...preserved]) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, "cache");
    }

    expect(await inspectModShaderCache([root], "22380")).toMatchObject({ files: 7, bytes: 35 });
    expect(await clearModShaderCache([root], "22380")).toBe(7);
    await Promise.all(
      generated.map((file) => expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" })),
    );
    await Promise.all(preserved.map((file) => expect(fs.stat(file)).resolves.toBeDefined()));
    await fs.rm(root, { recursive: true, force: true });
  });

  it("reports the Steam source and private-cache details shown to the user", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vortex-private-shaders-"));
    const app = path.join(root, "489830");
    const source = path.join(root, "steam", "489830");
    await fs.mkdir(app, { recursive: true });
    await fs.mkdir(source, { recursive: true });
    const sourceFile = path.join(source, "steam-cache.bin");
    const privateFile = path.join(app, "steam-cache.bin");
    await fs.writeFile(sourceFile, "steam");
    await fs.copyFile(sourceFile, privateFile);
    const sourceStat = await fs.stat(sourceFile);
    await fs.utimes(privateFile, sourceStat.atime, sourceStat.mtime);
    await fs.writeFile(
      path.join(app, ".vortex-steam-source.json"),
      JSON.stringify({
        appId: "489830",
        version: 1,
        fingerprint: "a".repeat(64),
        source,
      }),
    );

    expect(await inspectPrivateShaderCache(root, "489830", [source])).toMatchObject({
      changedFiles: 0,
      copiedFiles: 1,
      matchesSteam: true,
      privatePath: app,
      sourcePath: await fs.realpath(source),
      totalFiles: 1,
    });

    await fs.writeFile(path.join(app, "added.dxvk-cache"), "modded");
    expect(await inspectPrivateShaderCache(root, "489830", [source])).toMatchObject({
      changedFiles: 1,
      copiedFiles: 1,
      matchesSteam: false,
      totalFiles: 2,
    });
    await fs.writeFile(privateFile, "other");
    await fs.utimes(privateFile, sourceStat.atime, sourceStat.mtime);
    expect(await inspectPrivateShaderCache(root, "489830", [source])).toMatchObject({
      changedFiles: 2,
      copiedFiles: 0,
      missingFiles: 0,
      matchesSteam: false,
    });
    await fs.unlink(privateFile);
    expect(await inspectPrivateShaderCache(root, "489830", [source])).toMatchObject({
      missingFiles: 1,
    });
    const unrelated = await inspectPrivateShaderCache(root, "489830", [
      path.join(root, "different"),
    ]);
    expect(unrelated).toMatchObject({ copiedFiles: 0, matchesSteam: false });
    expect(unrelated.sourcePath).toBeUndefined();
    await fs.rm(root, { recursive: true, force: true });
  });
});
