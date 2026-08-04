#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { cp, mkdir } from "node:fs/promises";
import path from "node:path";

const WORKSPACE = path.resolve(import.meta.dirname, "../..");
const EXTENSIONS = path.join(WORKSPACE, "extensions");
const LOOT_ASSETS = path.join(import.meta.dirname, "assets/loot-linux");
const EXTRACT_INFO = path.join(WORKSPACE, "packages/vortex-api/bin/extractInfo.mjs");

function runNode(script, cwd) {
  const result = spawnSync(process.execPath, [script], { cwd, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`Failed to run ${path.relative(WORKSPACE, script)}`);
  }
}

async function buildExtension(name) {
  const extension = path.join(EXTENSIONS, name);
  await mkdir(path.join(extension, "dist"), { recursive: true });
  runNode(path.join(extension, "build.mjs"), extension);
  runNode(EXTRACT_INFO, extension);
  return extension;
}

async function preparePluginManagement() {
  const extension = await buildExtension("gamebryo-plugin-management");
  const loot = path.join(extension, "node_modules/loot");
  const files = [
    ["src/stylesheets/plugin_management.scss", "plugin_management.scss"],
    ["src/language.json", "language.json"],
    ["src/loot_icon.png", "loot_icon.png"],
    [path.join(loot, "async.js"), "async.js"],
    [path.join(loot, "loot_api/libloot.dll"), "libloot.dll"],
    [path.join(LOOT_ASSETS, "node-loot.node"), "node-loot.node"],
    [path.join(LOOT_ASSETS, "libloot.so.0"), "libloot.so.0"],
  ];
  await Promise.all(
    files.map(([source, name]) =>
      cp(
        path.isAbsolute(source) ? source : path.join(extension, source),
        path.join(extension, "dist", name),
      ),
    ),
  );
}

async function prepareBsaSupport() {
  const extension = await buildExtension("gamebryo-bsa-support");
  await cp(
    path.join(extension, "node_modules/bsatk/build/Release/bsatk.node"),
    path.join(extension, "dist/bsatk.node"),
  );
}

if (process.platform === "linux") {
  await Promise.all([
    buildExtension("gamebryo-archive-support"),
    prepareBsaSupport(),
    preparePluginManagement(),
  ]);
}
