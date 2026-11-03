import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const packageRoot = path.resolve(import.meta.dirname, "..");
export const workspaceRoot = path.resolve(packageRoot, "../..");

export function testWorkspace() {
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(temporaryRoot, "vortex-api-test-"));
  function dispose() {
    assert.equal(path.dirname(root), temporaryRoot);
    assert.ok(path.basename(root).startsWith("vortex-api-test-"));
    assert.equal(fs.lstatSync(root).isSymbolicLink(), false);
    fs.rmSync(root, { recursive: true, force: true });
  }
  try {
    fs.symlinkSync(
      path.join(workspaceRoot, "node_modules"),
      path.join(root, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    dispose();
    throw error;
  }
  return {
    root,
    write(relative: string, contents: string) {
      const file = path.resolve(root, relative);
      assert.ok(file.startsWith(root + path.sep));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, contents);
    },
    dispose,
  };
}
