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
  const extension = path.join(EXTENSIONS, "gamebryo-plugin-management");
  const loot = path.join(extension, "node_modules/loot");
  await Promise.all([
    mkdir(path.join(loot, "build/Release"), { recursive: true }),
    mkdir(path.join(loot, "loot_api"), { recursive: true }),
  ]);
  await Promise.all([
    cp(path.join(LOOT_ASSETS, "node-loot.node"), path.join(loot, "build/Release/node-loot.node")),
    cp(path.join(LOOT_ASSETS, "libloot.so.0"), path.join(loot, "loot_api/libloot.so.0")),
  ]);
  await buildExtension("gamebryo-plugin-management");
  await Promise.all([
    cp(
      path.join(extension, "src/stylesheets/plugin_management.scss"),
      path.join(extension, "dist/plugin_management.scss"),
    ),
    cp(path.join(extension, "src/language.json"), path.join(extension, "dist/language.json")),
    cp(path.join(extension, "src/loot_icon.png"), path.join(extension, "dist/loot_icon.png")),
  ]);
  runNode(path.join(extension, "copy-loot-native.mjs"), extension);
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
