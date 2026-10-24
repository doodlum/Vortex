/**
 * The Linux mount helper: a small Node program (Vortex's own Electron, run as Node) that owns
 * one game's FUSE mount, so the mods stay visible after Vortex closes, as they did with links:
 * Steam's Play button keeps working. Vortex talks to it through files only:
 *
 * - `<dir>/spec.json`: the session to serve (`addon`, `stateDir`, `artifactsDir`, `roots`,
 *   `generation`). The helper mounts it, and follows every change: the same root locations are
 *   updated in place (`setRoot`), others remount. Removing the file unmounts and ends the
 *   helper.
 * - `<dir>/status.json`: written by the helper, `{ pid, generation, mounted, error? }`, for
 *   Vortex to wait on. The helper touches it every two seconds and removes it when it ends.
 *
 * The source is written next to the spec when Vortex starts a helper, so nothing extra has to
 * be packaged.
 */
export const MOUNT_HELPER_SOURCE = String.raw`"use strict";
const fs = require("fs");
const path = require("path");
// The real path: libuv's Windows watcher aborts on a short (8.3) name.
const dir = fs.realpathSync.native(process.argv[2]);
const specFile = path.join(dir, "spec.json");
const statusFile = path.join(dir, "status.json");
let session;
let served;
let ending;

function writeStatus(status) {
  const temp = statusFile + "." + process.pid;
  fs.writeFileSync(temp, JSON.stringify({ pid: process.pid, ...status }));
  fs.renameSync(temp, statusFile);

}

function end() {
  close();
  try { fs.rmSync(statusFile, { force: true }); } catch (err) { /* gone */ }
  process.exit(0);
}

function close() {
  if (session !== undefined) {
    try { session.close(); } catch (err) { /* unmounted lazily by the addon */ }
    session = undefined;
    served = undefined;
  }
}

function sameLocations(a, b) {
  return a.length === b.length && a.every((root, i) => root.location === b[i].location);
}

function apply() {
  let spec;
  try {
    spec = JSON.parse(fs.readFileSync(specFile, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") {
      // Gone for good, not being replaced (which some systems do by deleting first): end.
      clearTimeout(ending);
      ending = setTimeout(() => { if (!fs.existsSync(specFile)) end(); }, 500);
    }
    return; // a spec being written: the next change event rereads it
  }
  if (served !== undefined && served.generation === spec.generation) return;
  let result;
  try {
    if (session !== undefined && sameLocations(served.roots, spec.roots)) {
      spec.roots.forEach((root, id) => session.setRoot(id, root));
    } else {
      close();
      const { Session } = require(spec.addon);
      session = new Session({ stateDir: spec.stateDir, artifactsDir: spec.artifactsDir, roots: spec.roots });
      session.start();
    }
    served = spec;
    result = { mounted: true };
  } catch (err) {
    close();
    served = spec;
    result = { mounted: false, error: String(err && err.message || err) };
  }
  writeStatus({ generation: spec.generation, ...result });
}

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, end);
}
apply();
fs.watch(dir, () => apply());
setInterval(() => {
  // A watch can miss a rename on some file systems: look again now and then.
  apply();
  // The heartbeat Vortex tells a running helper from a dead one's status by.
  const now = new Date();
  try { fs.utimesSync(statusFile, now, now); } catch (err) { /* written next time */ }
}, 2000);
`;
