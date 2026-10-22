#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
