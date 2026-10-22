import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, expect, it } from "vitest";

import type { IDeployedFile } from "../types/IDeploymentMethod";
import { canonicalDeployment } from "./canonicalDeployment";

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "vortex-canonical-deployment-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
const fold = (value: string) => value.toUpperCase();
const file = (relPath: string, sourceRelPath?: string, target = ""): IDeployedFile => ({
  relPath: path.normalize(relPath),
  sourceRelPath: sourceRelPath && path.normalize(sourceRelPath),
  source: "mod",
  target,
  time: 1,
});

it("retains existing output case and the original staging path without mutating input", async () => {
  await fs.mkdir(path.join(root, "Config"));
  await fs.writeFile(path.join(root, "Config", "Settings.ini"), "base");
  const input = file("config/settings.ini");
  const result = await canonicalDeployment(root, [input], [], fold);
  expect(result[0]).toMatchObject({
    relPath: path.join("Config", "Settings.ini"),
    sourceRelPath: path.join("config", "settings.ini"),
  });
  expect(input.relPath).toBe(path.join("config", "settings.ini"));
});

it("reserves one spelling for missing shared directories independently of activation order", async () => {
  const input = [file("textures/z.dds"), file("Textures/a.dds")];
  const first = await canonicalDeployment(root, input, [], fold);
  const reverse = await canonicalDeployment(root, [...input].reverse(), [], fold);
  expect(first.map((entry) => entry.relPath)).toEqual([
    path.join("Textures", "z.dds"),
    path.join("Textures", "a.dds"),
  ]);
  expect(reverse.map((entry) => entry.relPath)).toEqual(
    [...first].reverse().map((entry) => entry.relPath),
  );
});

it("uses a missing destination's previous manifest spelling", async () => {
  const result = await canonicalDeployment(
    root,
    [file("config/settings.ini")],
    [file("Config/Settings.ini")],
    fold,
  );
  expect(result[0].relPath).toBe(path.join("Config", "Settings.ini"));
});

it("uses a base backup's original spelling while the live output is absent", async () => {
  await fs.mkdir(path.join(root, "Config"));
  await fs.writeFile(path.join(root, "Config", "Settings.ini.vortex_backup"), "base");
  const result = await canonicalDeployment(root, [file("config/settings.ini")], [], fold);
  expect(result[0].relPath).toBe(path.join("Config", "Settings.ini"));
});

it("keeps the mod target separate from its staging-relative path", async () => {
  await fs.mkdir(path.join(root, "MyMod", "Config"), { recursive: true });
  await fs.writeFile(path.join(root, "MyMod", "Config", "Settings.ini"), "base");
  const result = await canonicalDeployment(
    root,
    [file("config/settings.ini", undefined, "mymod")],
    [],
    fold,
  );
  expect(result[0]).toMatchObject({
    target: "MyMod",
    relPath: path.join("Config", "Settings.ini"),
    sourceRelPath: path.join("config", "settings.ini"),
  });
});

it("retains an already distinct staging path through a partial deployment", async () => {
  const previous = file("Config/Settings.ini", "config/settings.ini");
  const result = await canonicalDeployment(root, [previous], [previous], fold);
  expect(result[0]).toEqual(previous);
});

it("leaves native case-sensitive paths unchanged", async () => {
  const input = [file("Foo"), file("foo")];
  expect(await canonicalDeployment(root, input, [], (value) => value)).toBe(input);
});

it("refuses relative paths escaping the deployment directory", async () => {
  await expect(canonicalDeployment(root, [file("../outside")], [], fold)).rejects.toThrow(
    "Invalid relative deployment path",
  );
});

it.skipIf(process.platform === "win32")(
  "refuses an ambiguous component without choosing an unrelated case variant",
  async () => {
    await fs.mkdir(path.join(root, "Data"));
    await fs.mkdir(path.join(root, "data"));
    await expect(canonicalDeployment(root, [file("DATA/file")], [], fold)).rejects.toThrow(
      "Ambiguous deployment path",
    );
  },
);

it("chooses directory spelling with a portable separator sort order", async () => {
  const result = await canonicalDeployment(
    root,
    [file("dir/A0/file"), file("DIR/A/file")],
    [],
    fold,
  );
  expect(result.map((entry) => entry.relPath)).toEqual([
    path.join("DIR", "A0", "file"),
    path.join("DIR", "A", "file"),
  ]);
});
