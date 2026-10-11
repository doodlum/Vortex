import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "vitest";

const checkout = path.resolve(import.meta.dirname, "../../../..");
const mainRequire = createRequire(path.join(checkout, "src/main/package.json"));
const builderRequire = createRequire(mainRequire.resolve("electron-builder/package.json"));
const libRequire = createRequire(builderRequire.resolve("app-builder-lib/package.json"));
const asar = libRequire("@electron/asar") as {
  createPackage: (source: string, destination: string) => Promise<void>;
};
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (
      path.dirname(root) !== path.resolve(os.tmpdir()) ||
      !path.basename(root).startsWith("vortex-hash-package-")
    ) {
      throw Error("Invalid package fixture cleanup target");
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function fixture(change?: {
  location: "deploy" | "package";
  entry: string;
  content?: string;
}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vortex-hash-package-"));
  roots.push(root);
  const deploy = path.join(root, "deploy", "node_modules");
  const build = path.join(root, "deploy", "build");
  const packed = path.join(root, "packed");
  await Promise.all([
    fs.mkdir(deploy, { recursive: true }),
    fs.mkdir(build, { recursive: true }),
    fs.mkdir(packed),
  ]);
  for (const entry of ["hash-worker.cjs", "hash-worker.cjs.map"]) {
    for (const [location, directory] of [
      ["deploy", build],
      ["package", packed],
    ] as const) {
      let content = "fixture bytes for " + entry;
      if (change !== undefined && change.location === location && change.entry === entry) {
        if (change.content === undefined) continue;
        content = change.content;
      }
      await fs.writeFile(path.join(directory, entry), content);
    }
  }
  const archive = path.join(root, "app.asar");
  await asar.createPackage(packed, archive);
  return spawnSync(
    process.execPath,
    [
      path.join(checkout, "scripts/verify-packaged-asar.mjs"),
      "--deploy",
      deploy,
      "--asar",
      archive,
    ],
    { cwd: checkout, encoding: "utf8" },
  );
}

test("package verification accepts exact deployed hash worker and map bytes", async () => {
  const result = await fixture();
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
});

test.each(["hash-worker.cjs", "hash-worker.cjs.map"])(
  "package verification rejects missing %s in the ASAR",
  async (entry) => {
    const result = await fixture({ location: "package", entry });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("MISSING packaged " + entry);
  },
);

test("package verification rejects a stale packaged hash worker", async () => {
  const result = await fixture({
    location: "package",
    entry: "hash-worker.cjs",
    content: "stale worker",
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("MISMATCH hash-worker.cjs: package differs from deployed build");
});

test("package verification rejects a missing deployed hash worker", async () => {
  const result = await fixture({ location: "deploy", entry: "hash-worker.cjs" });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("MISSING deployed hash-worker.cjs");
});
