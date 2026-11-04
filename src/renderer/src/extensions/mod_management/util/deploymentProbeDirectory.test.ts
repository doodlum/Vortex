import * as nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import * as fs from "../../../util/fs";
import { deploymentProbeDirectory } from "./deploymentProbeDirectory";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) nodeFs.rmSync(root, { recursive: true, force: true });
});
function root() {
  const dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), "vortex-probe-"));
  roots.push(dir);
  return dir;
}

it("uses the nearest existing ancestor without making any missing output", () => {
  const dir = root();
  const target = path.join(dir, "Mods", "Nested");
  expect(deploymentProbeDirectory(target)).toBe(dir);
  expect(nodeFs.readdirSync(dir)).toEqual([]);
  nodeFs.mkdirSync(path.dirname(target));
  expect(deploymentProbeDirectory(target)).toBe(path.dirname(target));
});

it.each(["EACCES", "EPERM", "EIO", "ELOOP"])(
  "does not bypass %s by probing a writable parent",
  (code) => {
    const dir = root();
    const target = path.join(dir, "Mods");
    nodeFs.mkdirSync(target);
    const access = vi.spyOn(fs, "accessSync").mockImplementation(() => {
      throw Object.assign(new Error(code), { code });
    });
    expect(() => deploymentProbeDirectory(target)).toThrow(code);
    expect(access).toHaveBeenCalledTimes(1);
  },
);

it("does not treat a regular file in the output path as a missing directory", () => {
  const dir = root();
  const file = path.join(dir, "Mods");
  nodeFs.writeFileSync(file, "keep me");
  expect(() => deploymentProbeDirectory(file)).toThrow();
  expect(() => deploymentProbeDirectory(path.join(file, "Nested"))).toThrow();
  expect(nodeFs.readFileSync(file, "utf8")).toBe("keep me");
});

it("preserves a dangling directory symlink and refuses it", () => {
  const dir = root();
  const target = path.join(dir, "Mods");
  nodeFs.symlinkSync(path.join(dir, "Missing"), target, "junction");
  expect(() => deploymentProbeDirectory(target)).toThrow();
  expect(nodeFs.lstatSync(target).isSymbolicLink()).toBe(true);
});

it("uses the existing symlink destination for filesystem and permission probes", () => {
  const dir = root();
  const target = path.join(dir, "Mods");
  const physical = path.join(dir, "Physical");
  nodeFs.mkdirSync(physical);
  nodeFs.symlinkSync(physical, target, "junction");
  expect(deploymentProbeDirectory(target)).toBe(target);
  expect(nodeFs.statSync(target).ino).toBe(nodeFs.statSync(physical).ino);
});
