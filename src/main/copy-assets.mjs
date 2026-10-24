#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, basename, dirname } from "node:path";

import { glob } from "glob";

const require = createRequire(import.meta.url);

// Keep in step with nativeRuntimeBundle.ts, which verifies the same hashes at runtime.
const MONO_RUNTIME = {
  url: "https://raw.githubusercontent.com/doodlum/fomod-installer",
  commit: "1c08e0f9bc66735488826da85bb068cbc873d10f",
  files: {
    "mono-runtime-linux-x64.zip":
      "edb3c116bdf7d371a7bda45f32b5c59af81d71bb9baf42e8e1831e5e6f46ec88",
    "mono-runtime-linux-x64.json":
      "b4143f1f1fa5d90945395a4821f083ede68522b5f8c57a9c24d208103496fd1a",
  },
};
const digest = (data) => createHash("sha256").update(data).digest("hex");

// aether-vfs, the virtual file system deployment runs on (extensions/vfs_deployment): its Node
// binding and the shim it injects, as published by doodlum/aether-vfs's vortex-artifacts
// workflow, one release per commit. Each file is pinned by its SHA-256 and installed under the
// name the extension loads (and `mode`, for a program). `VORTEX_AETHER_VFS_DIR` points a
// development build at a local one.
const AETHER_VFS = {
  url: "https://github.com/doodlum/aether-vfs/releases/download",
  tag: "vortex-a615335be9a4",
  files: {
    "win32-x64": {
      "aether_vfs_node-win32-x64.node": {
        name: "aether_vfs_node.node",
        sha256: "932eeb26c89b1ac8b66ddbb7c8f37db6f5377273ff66277e4cb8531ebbbd1ac8",
      },
      "vfs_shim_dll-win32-x64.dll": {
        name: "vfs_shim_dll.dll",
        sha256: "6673c2772a584b546e56f2e5c465fa488d5248cda171cbbd60bdf73d6ede815f",
      },
      // 32-bit games get the 32-bit shim, and its injector, from the x86 folder.
      "vfs_shim_dll-win32-ia32.dll": {
        name: "x86/vfs_shim_dll.dll",
        sha256: "a1c577a56d4ecac5fb0a1ccfbf9ba1d7a59c2f02b7f558fa7d74ffd86dad2d29",
      },
      "vfs-injector-win32-ia32.exe": {
        name: "x86/vfs-injector.exe",
        sha256: "95b358b44f915621bae632b3e1b09461585da27e91626c4122cf4ca2dd1ec31d",
      },
    },
    // Linux mounts game folders (FUSE): the binding, no shim, and the relay a Flatpak mounts
    // through on the host (vfs_deployment/mounts.ts).
    "linux-x64": {
      "aether_vfs_node-linux-x64.node": {
        name: "aether_vfs_node.node",
        sha256: "a0b57365e2124da5f38693044a6eb41c165ca02a8de991648a3a18c37950f365",
      },
      "fusermount-relay-linux-x64": {
        name: "fusermount-relay",
        sha256: "7e09c8881c7a2d0349c7995a136935f2b4153b16b98a56a37ccd55a40c6994fb",
        mode: 0o755,
      },
    },
  },
};

const WORKSPACE = join(import.meta.dirname, "../..");
const BUILD = join(import.meta.dirname, "build");
const ASSETS = join(BUILD, "assets");

async function copy(src, dest) {
  await mkdir(join(dest, ".."), { recursive: true });
  await cp(src, dest, { recursive: true, force: true });
  console.log(`copied ${src} to ${dest}`);
}

// @vortex/stylesheets compiled outputs
for (const file of ["loadingScreen.css", "tailwind-v4.css"]) {
  await copy(join(WORKSPACE, "src/stylesheets/dist", file), join(BUILD, "assets/css", file));
}

// @tools/dotnetprobe compiled outputs
const dotnetprobeFiles =
  process.platform === "win32" ? await glob("tools/dotnetprobe/dist/*", { cwd: WORKSPACE }) : [];
for (const file of dotnetprobeFiles) {
  const rel = file.slice("tools/dotnetprobe/dist/".length);
  await copy(join(WORKSPACE, file), join(BUILD, "assets", rel));
}

// Legacy C# installers on Linux x64: a pinned Mono runtime (verified again before use, see
// installer_fomod_ipc/utils/nativeRuntimeBundle.ts) and the helper's Mono build from
// @nexusmods/fomod-installer-ipc. Windows retains its Desktop Runtime helper and installer.
if (process.platform === "linux" && process.arch === "x64") {
  const destination = join(ASSETS, "fomod-csharp");
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  for (const [name, sha256] of Object.entries(MONO_RUNTIME.files)) {
    const cached = join(WORKSPACE, "node_modules/.cache/fomod-csharp", MONO_RUNTIME.commit, name);
    if (!existsSync(cached) || digest(await readFile(cached)) !== sha256) {
      const response = await fetch(`${MONO_RUNTIME.url}/${MONO_RUNTIME.commit}/${name}`);
      if (!response.ok) throw new Error(`Downloading ${name} failed: ${response.status}`);
      const data = Buffer.from(await response.arrayBuffer());
      if (digest(data) !== sha256) throw new Error(`${name} does not match its pinned SHA-256`);
      await mkdir(dirname(cached), { recursive: true });
      await writeFile(cached, data);
    }
    await copy(cached, join(destination, name));
  }
  const ipcPackage = dirname(require.resolve("@nexusmods/fomod-installer-ipc/package.json"));
  await copy(join(ipcPackage, "dist/mono"), join(destination, "helper"));
}

// aether-vfs: downloaded once into the workspace cache, verified on every copy.
{
  const files = AETHER_VFS.files[`${process.platform}-${process.arch}`];
  const destination = join(ASSETS, "aether-vfs");
  await rm(destination, { recursive: true, force: true });
  if (files === undefined) {
    console.log(`no aether-vfs build for ${process.platform}-${process.arch}`);
  } else {
    await mkdir(destination, { recursive: true });
    for (const [asset, { name, sha256, mode }] of Object.entries(files)) {
      const cached = join(WORKSPACE, "node_modules/.cache/aether-vfs", AETHER_VFS.tag, asset);
      if (!existsSync(cached) || digest(await readFile(cached)) !== sha256) {
        const response = await fetch(`${AETHER_VFS.url}/${AETHER_VFS.tag}/${asset}`);
        if (!response.ok) throw new Error(`Downloading ${asset} failed: ${response.status}`);
        const data = Buffer.from(await response.arrayBuffer());
        if (digest(data) !== sha256) throw new Error(`${asset} does not match its pinned SHA-256`);
        await mkdir(dirname(cached), { recursive: true });
        await writeFile(cached, data);
      }
      await copy(cached, join(destination, name));
      if (mode !== undefined) await chmod(join(destination, name), mode);
    }
  }
}

// SCSS sources for runtime stylesheet compiler load paths
const scssFiles = await glob("src/stylesheets/**/*.scss", {
  cwd: WORKSPACE,
  ignore: ["src/stylesheets/node_modules/**"],
});
for (const file of scssFiles) {
  const rel = file.slice("src/stylesheets/".length);
  await copy(join(WORKSPACE, file), join(BUILD, "assets/css", rel));
}

// bootstrap-sass source (resolved from main's deps, not workspace root)
const bootstrapSassDir = dirname(require.resolve("bootstrap-sass/package.json"));
await copy(
  join(bootstrapSassDir, "assets/stylesheets/_bootstrap.scss"),
  join(BUILD, "assets/css/bootstrap.scss"),
);

// node-loot runtime pieces, resolved from the renderer's deps: loot must stay out
// of @vortex/main's tree, or electron-rebuild force-rebuilds it against electron
// headers and the link fails where libloot is absent. The install-time node-gyp
// build targets napi, so electron loads it without a rebuild. The package layout
// is preserved so async.js's relative require of build/Release/node-loot resolves,
// and libloot is placed next to the binding the Windows loader searches the loaded
// module's directory, the Linux binding's rpath starts at its own.
try {
  const rendererRequire = createRequire(join(WORKSPACE, "src/renderer/package.json"));
  const lootDir = dirname(rendererRequire.resolve("loot/package.json"));
  const library = process.platform === "win32" ? "libloot.dll" : "libloot.so.0";
  await copy(join(lootDir, "index.js"), join(ASSETS, "loot/index.js"));
  await copy(join(lootDir, "async.js"), join(ASSETS, "loot/async.js"));
  await copy(
    join(lootDir, "build/Release/node-loot.node"),
    join(ASSETS, "loot/build/Release/node-loot.node"),
  );
  await copy(join(lootDir, "loot_api", library), join(ASSETS, "loot/build/Release", library));
} catch {
  console.log("skipped node-loot runtime pieces (loot is not installed on this platform)");
}

// Static files
await copy(join(WORKSPACE, "LICENSE.md"), join(BUILD, "LICENSE.md"));
await copy(join(WORKSPACE, "src/renderer/src/index.html"), join(BUILD, "index.html"));
await copy(join(WORKSPACE, "src/renderer/src/splash.html"), join(BUILD, "splash.html"));
await copy(join(WORKSPACE, "src/queries"), join(BUILD, "queries"));

// Static assets
for (const dir of ["fonts", "icons", "images", "pictograms"]) {
  await copy(join(WORKSPACE, "assets", dir), join(ASSETS, dir));
}

// The Material Symbols font, from the renderer's deps, which own the Icon component.
const symbolsDir = dirname(
  createRequire(join(WORKSPACE, "src/renderer/package.json")).resolve(
    "material-symbols/package.json",
  ),
);
await copy(
  join(symbolsDir, "material-symbols-outlined.woff2"),
  join(ASSETS, "fonts/material-symbols-outlined.woff2"),
);

for (const file of await glob("assets/*.json", { cwd: WORKSPACE })) {
  await copy(join(WORKSPACE, file), join(ASSETS, basename(file)));
}

// Locales (dev only)
if (process.env.NODE_ENV !== "production") {
  for (const file of await glob("locales/*/*", { cwd: WORKSPACE })) {
    const parts = file.split("/");
    await copy(join(WORKSPACE, file), join(BUILD, ...parts));
  }
}

console.log("assets copied");
