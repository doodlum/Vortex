import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

// Resolve the main package's pinned Electron, without importing its lazy installer
// in parallel test workers. This process must finish before Nx starts those workers.
const requireMain = createRequire(new URL("../src/main/package.json", import.meta.url));
const installer = requireMain.resolve("electron/install.js");
const result = spawnSync(process.execPath, [installer], { stdio: "inherit" });
if (result.error !== undefined) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

// Do not import electron/index.js: its lazy loader can start a second installer
// if the first exited successfully without publishing a complete runtime.
const packageDirectory = path.dirname(installer);
const executableName = readFileSync(path.join(packageDirectory, "path.txt"), "utf8");
const dist = process.env.ELECTRON_OVERRIDE_DIST_PATH || path.join(packageDirectory, "dist");
const executable = path.resolve(dist, executableName);
const relative = path.relative(path.resolve(dist), executable);
if (
  executableName.length === 0 ||
  path.isAbsolute(executableName) ||
  relative === ".." ||
  relative.startsWith(".." + path.sep) ||
  path.isAbsolute(relative) ||
  !statSync(executable).isFile()
) {
  throw new Error("Electron installation did not produce an executable file");
}
