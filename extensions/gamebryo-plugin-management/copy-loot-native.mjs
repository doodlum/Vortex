#!/usr/bin/env node

import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const extension = import.meta.dirname;
const loot = path.join(extension, "node_modules/loot");
const destination = path.join(extension, "dist");
const platformLibrary = process.platform === "win32" ? "libloot.dll" : "libloot.so.0";

if (!["win32", "linux"].includes(process.platform)) {
  process.exit(0);
}

await mkdir(destination, { recursive: true });
await Promise.all([
  copyFile(
    path.join(loot, "build/Release/node-loot.node"),
    path.join(destination, "node-loot.node"),
  ),
  copyFile(path.join(loot, "loot_api", platformLibrary), path.join(destination, platformLibrary)),
  copyFile(path.join(loot, "async.js"), path.join(destination, "async.js")),
]);

const worker = path.join(destination, "async.js");
const source = await readFile(worker, "utf8");
await writeFile(worker, source.replace("./build/Release/node-loot", "./node-loot"));
