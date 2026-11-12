import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, it } from "vitest";
const installed = `
  fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'path.txt'), 'electron-fixture');
  fs.writeFileSync(path.join(__dirname, 'dist/electron-fixture'), 'not executable');
`;
function runFixture(
  install: string,
  check: (result: ReturnType<typeof spawnSync>, electron: string) => void,
  rootCommand = false,
  emptyOverride = false,
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vortex-electron-prerequisite-"));
  if (
    path.dirname(root) !== path.resolve(os.tmpdir()) ||
    !path.basename(root).startsWith("vortex-electron-prerequisite-")
  )
    throw Error("Invalid fixture cleanup path");
  try {
    const scripts = path.join(root, "scripts"),
      main = path.join(root, "src/main");
    const electron = path.join(main, "node_modules/electron"),
      bin = path.join(root, "bin");
    fs.mkdirSync(scripts, { recursive: true });
    fs.mkdirSync(electron, { recursive: true });
    fs.mkdirSync(bin);
    fs.copyFileSync(
      path.join(import.meta.dirname, "ensure-electron.mjs"),
      path.join(scripts, "ensure-electron.mjs"),
    );
    fs.writeFileSync(path.join(main, "package.json"), '{"name":"fixture"}');
    fs.writeFileSync(path.join(electron, "package.json"), '{"name":"electron","main":"index.js"}');
    fs.writeFileSync(
      path.join(electron, "install.js"),
      `const fs = require('node:fs'), path = require('node:path');\n` + install,
    );
    // Model Electron's actual lazy second install, and make any import observable.
    fs.writeFileSync(
      path.join(electron, "index.js"),
      `
      const fs = require('node:fs'), path = require('node:path');
      fs.writeFileSync(path.join(__dirname, 'imported.txt'), 'imported');
      const binary = path.join(__dirname, 'dist/electron-fixture');
      if (!fs.existsSync(binary)) require('node:child_process').spawnSync(process.execPath, [path.join(__dirname, 'install.js')]);
      module.exports = binary;
    `,
    );
    const command = JSON.parse(
      fs.readFileSync(path.join(import.meta.dirname, "../package.json"), "utf8"),
    ).scripts.test;
    fs.writeFileSync(
      path.join(bin, process.platform === "win32" ? "pnpm.cmd" : "pnpm"),
      process.platform === "win32"
        ? "@echo off\r\necho TEST_WORKER_STARTED\r\nexit /b 0\r\n"
        : "#!/bin/sh\necho TEST_WORKER_STARTED\nexit 0\n",
      { mode: 0o755 },
    );
    const environment = { ...process.env, PATH: bin + path.delimiter + process.env.PATH };
    delete environment.ELECTRON_OVERRIDE_DIST_PATH;
    if (emptyOverride) environment.ELECTRON_OVERRIDE_DIST_PATH = "";
    const result = rootCommand
      ? spawnSync(command, { cwd: root, shell: true, encoding: "utf8", env: environment })
      : spawnSync(process.execPath, [path.join(scripts, "ensure-electron.mjs")], {
          cwd: root,
          encoding: "utf8",
          env: environment,
        });
    check(result, electron);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
it("finishes the installer and checks its output without importing or launching Electron", () => {
  runFixture(`setTimeout(() => { ${installed} }, 30);`, (result, electron) => {
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(fs.existsSync(path.join(electron, "imported.txt"))).toBe(false);
  });
});
it("uses the default dist when the override is explicitly empty", () => {
  runFixture(
    installed,
    (result, electron) => {
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(fs.existsSync(path.join(electron, "imported.txt"))).toBe(false);
    },
    false,
    true,
  );
});
it("preserves installer failure without importing Electron", () => {
  runFixture("console.error('installer failed'); process.exit(23);", (result, electron) => {
    expect(result.status).toBe(23);
    expect(result.stderr).toContain("installer failed");
    expect(fs.existsSync(path.join(electron, "imported.txt"))).toBe(false);
  });
});
it("does not retry a successful installer that leaves its output incomplete", () => {
  runFixture(
    `
    const countFile = path.join(__dirname, 'count.txt');
    const count = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile)) + 1 : 1;
    fs.writeFileSync(countFile, String(count));
    if (count > 1) { ${installed} }
  `,
    (result, electron) => {
      expect(result.status).not.toBe(0);
      expect(fs.readFileSync(path.join(electron, "count.txt"), "utf8")).toBe("1");
      expect(fs.existsSync(path.join(electron, "imported.txt"))).toBe(false);
    },
  );
});
it("rejects a directory masquerading as an installed executable", () => {
  runFixture(
    `
    fs.mkdirSync(path.join(__dirname, 'dist/electron-fixture'), { recursive: true });
    fs.writeFileSync(path.join(__dirname, 'path.txt'), 'electron-fixture');
  `,
    (result) => {
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Electron installation did not produce an executable file");
    },
  );
});
it("the actual root test command stops before workers when installation fails", () => {
  runFixture(
    "console.error('installer failed'); process.exit(23);",
    (result) => {
      expect(result.status).toBe(23);
      expect(result.stderr).toContain("installer failed");
      expect(result.stdout).not.toContain("TEST_WORKER_STARTED");
    },
    true,
  );
});
