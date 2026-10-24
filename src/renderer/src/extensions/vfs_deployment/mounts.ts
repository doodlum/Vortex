import { spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

import type { IExtensionApi } from "../../types/IExtensionContext";
import getVortexPath from "../../util/getVortexPath";
import { log } from "../../util/log";
import { loadAether } from "./aether";
import { MOUNT_HELPER_SOURCE } from "./mountHelper";
import { deploymentForGame, gameRoots } from "./roots";

/**
 * Linux: a game deployed through the virtual file system has its roots mounted at their real
 * locations (FUSE). Every program sees the mods there with no help: the game started by Vortex
 * or by Steam's own Play button, tools, and Vortex itself. What programs write lands in the
 * roots' write folders, as on Windows.
 *
 * A mount helper owns each game's mount (mountHelper.ts), so the mods stay visible after
 * Vortex closes, as they did with links. A deploy unmounts first, so that the deployment reads
 * the game's own files (merging from originals, say), and mounts the new deployment when it is
 * done; a purge unmounts.
 */

/**
 * Bumped by every mount and unmount of a game: a mount still reading the manifests when an
 * unmount (a deploy starting) or a newer mount comes gives up instead of mounting late.
 */
const generations = new Map<string, number>();
const bump = (gameId: string) => {
  const next = (generations.get(gameId) ?? 0) + 1;
  generations.set(gameId, next);
  return next;
};

export const mountsApply = () => process.platform === "linux";

interface IHelperStatus {
  pid: number;
  generation: number;
  mounted: boolean;
  error?: string;
}

const mountsDir = () => path.join(getVortexPath("userData"), "vfs-mounts");
const helperDir = (gameId: string) => path.join(mountsDir(), gameId);
const statusFile = (gameId: string) => path.join(helperDir(gameId), "status.json");

/** How long a helper may go without touching its status before it counts as gone. */
const HEARTBEAT_LIMIT_MS = 6000;

/**
 * The helper's status while it runs. It touches the file every two seconds and removes it when
 * it ends; a status left by a helper that died goes stale. (A Flatpak helper runs in its own
 * sandbox, whose process ids mean nothing here.)
 */
function liveStatus(gameId: string): IHelperStatus | undefined {
  try {
    const file = statusFile(gameId);
    if (Date.now() - fs.statSync(file).mtimeMs > HEARTBEAT_LIMIT_MS) {
      return undefined;
    }
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Whether `gameId`'s helper is up and serving its mount. */
export function isMounted(gameId: string): boolean {
  return liveStatus(gameId)?.mounted === true;
}

/** Start a helper for `dir`, detached, so that it outlives Vortex. */
function startHelper(dir: string): void {
  const helper = path.join(dir, "helper.cjs");
  fs.writeFileSync(helper, MOUNT_HELPER_SOURCE);
  // Vortex's own Electron, run as Node.
  const env = { ELECTRON_RUN_AS_NODE: "1", FUSERMOUNT_PATH: process.env.FUSERMOUNT_PATH };
  const [command, args] = isFlatpak()
    ? // Everything a Flatpak app starts ends with it; a process the portal starts in a new
      // sandbox of the same app does not.
      [
        "flatpak-spawn",
        [
          ...Object.entries(env)
            .filter(([, value]) => value !== undefined)
            .map(([name, value]) => `--env=${name}=${value}`),
          process.execPath,
          helper,
          dir,
        ],
      ]
    : [process.execPath, [helper, dir]];
  const output = fs.openSync(path.join(dir, "helper.log"), "a");
  try {
    spawn(command, args, {
      detached: true,
      stdio: ["ignore", output, output],
      env: { ...process.env, ...env },
    }).unref();
  } finally {
    fs.closeSync(output);
  }
}

/** Mount `gameId`'s deployment as its manifests describe it, or update the mount it has. */
export async function mountGame(api: IExtensionApi, gameId: string): Promise<void> {
  if (!mountsApply()) {
    return;
  }
  const mine = bump(gameId);
  const aether = loadAether();
  const game = await deploymentForGame(api, gameId);
  if (aether === undefined || game === undefined || generations.get(gameId) !== mine) {
    return;
  }
  const dir = helperDir(gameId);
  fs.mkdirSync(dir, { recursive: true });
  useHostFusermount();
  const generation = Date.now() * 1000 + mine;
  const spec = {
    addon: aether.addon,
    stateDir: path.join(dir, "state"),
    artifactsDir: aether.dir,
    roots: gameRoots(game),
    generation,
  };
  const specFile = path.join(dir, "spec.json");
  fs.writeFileSync(`${specFile}.tmp`, JSON.stringify(spec));
  fs.renameSync(`${specFile}.tmp`, specFile);
  if (liveStatus(gameId) === undefined) {
    startHelper(dir);
  }
  for (let waited = 0; waited < 15000; waited += 100) {
    const status = liveStatus(gameId);
    if (status?.generation === generation) {
      if (status.mounted) {
        log("info", "mounted the virtual file system", { gameId, pid: status.pid });
      } else {
        log("error", "failed to mount the virtual file system", { gameId, error: status.error });
        api.showErrorNotification("The game cannot see its mods", status.error ?? "", {
          allowReport: false,
          message: "Mounting the virtual file system failed.",
        });
      }
      return;
    }
    await delay(100);
  }
  log("error", "the mount helper did not answer", { gameId });
}

/**
 * Unmount `gameId`'s deployment (lazily, if a program still holds files there), and wait for
 * its helper to end: a deploy that follows must see the game's own files.
 */
export async function unmountGame(gameId: string): Promise<void> {
  bump(gameId);
  const running = liveStatus(gameId) !== undefined;
  fs.rmSync(path.join(helperDir(gameId), "spec.json"), { force: true });
  if (!running) {
    return;
  }
  for (let waited = 0; liveStatus(gameId) !== undefined; waited += 100) {
    if (waited >= 15000) {
      log("error", "the mount helper did not unmount", { gameId });
      return;
    }
    await delay(100);
  }
  log("info", "unmounted the virtual file system", { gameId });
}
/** Whether this machine can mount: `/dev/fuse` and `fusermount3` (package fuse3). */
export function canMount(): boolean {
  if (isFlatpak()) {
    return hostCanMount();
  }
  if (!fs.existsSync("/dev/fuse")) {
    return false;
  }
  return (process.env.PATH ?? "")
    .split(path.delimiter)
    .some((dir) => dir !== "" && fs.existsSync(path.join(dir, "fusermount3")));
}

const isFlatpak = () => process.env.IS_FLATPAK === "true";

let hostMount: boolean | undefined;

/** Flatpak: whether the host has FUSE, asked once (the sandbox has neither). */
function hostCanMount(): boolean {
  hostMount ??=
    spawnSync(
      "flatpak-spawn",
      ["--host", "sh", "-c", "test -e /dev/fuse && command -v fusermount3"],
      { timeout: 10000 },
    ).status === 0;
  return hostMount;
}

/**
 * A Flatpak Vortex mounts through the host's `fusermount3`: the sandbox has none and cannot
 * mount. aether-vfs runs `$FUSERMOUNT_PATH`, which forwards the socket the FUSE device comes
 * back on (`_FUSE_COMMFD`) to the host helper. The mount is then made on the host, where the
 * games and Steam run; Vortex itself sees the deployment through its file view.
 */
function useHostFusermount(): void {
  if (!isFlatpak() || process.env.FUSERMOUNT_PATH !== undefined) {
    return;
  }
  // Beside the helpers, which a Flatpak helper sandbox shares (its /tmp is its own).
  const wrapper = path.join(mountsDir(), "host-fusermount3");
  fs.mkdirSync(path.dirname(wrapper), { recursive: true });
  fs.writeFileSync(
    wrapper,
    [
      "#!/bin/sh",
      'if [ -n "$_FUSE_COMMFD" ]; then',
      '  exec flatpak-spawn --host --forward-fd="$_FUSE_COMMFD" --env=_FUSE_COMMFD="$_FUSE_COMMFD" fusermount3 "$@"',
      "fi",
      'exec flatpak-spawn --host fusermount3 "$@"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  fs.chmodSync(wrapper, 0o755);
  process.env.FUSERMOUNT_PATH = wrapper;
}
