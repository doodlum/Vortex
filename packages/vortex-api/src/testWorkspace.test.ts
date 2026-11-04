import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";

import { expect, it } from "vitest";

import { testWorkspace, workspaceRoot } from "./testWorkspace";

it.runIf(process.platform === "win32")(
  "cleans an owned temporary workspace after a child releases its working directory",
  async () => {
    const fixture = testWorkspace();
    fixture.write("retention-control.txt", "Owned test input\n");
    const modules = workspaceRoot + "/node_modules";
    const before = fs.realpathSync(modules);
    const child = spawn(
      process.execPath,
      ["-e", "process.stdout.write('holding\\n');setTimeout(()=>{},350)"],
      { cwd: fixture.root, stdio: ["ignore", "pipe", "pipe"] },
    );
    const closed = once(child, "close");
    try {
      expect(child.stdout).not.toBeNull();
      await once(child.stdout!, "data");
      expect(() => fixture.dispose()).not.toThrow();
      expect(fs.existsSync(fixture.root)).toBe(false);
      expect((await closed)[0]).toBe(0);
      expect(fs.realpathSync(modules)).toBe(before);
    } finally {
      if (child.exitCode === null) child.kill();
      await closed;
      if (fs.existsSync(fixture.root)) fixture.dispose();
    }
  },
  10000,
);

it.runIf(process.platform === "win32")(
  "reports a workspace that remains locked beyond bounded cleanup retries",
  async () => {
    const fixture = testWorkspace();
    fixture.write("persistent-lock-control.txt", "Owned test input\n");
    const child = spawn(
      process.execPath,
      ["-e", "process.stdout.write('holding\\n');setTimeout(()=>{},5000)"],
      { cwd: fixture.root, stdio: ["ignore", "pipe", "pipe"] },
    );
    const closed = once(child, "close");
    try {
      expect(child.stdout).not.toBeNull();
      await once(child.stdout!, "data");
      let failure: unknown;
      try {
        fixture.dispose();
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: "EPERM" });
      expect(fs.existsSync(fixture.root)).toBe(true);
    } finally {
      if (child.exitCode === null) child.kill();
      await closed;
      if (fs.existsSync(fixture.root)) fixture.dispose();
    }
  },
  10000,
);
