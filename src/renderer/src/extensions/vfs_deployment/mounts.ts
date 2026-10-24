import { spawn, spawnSync } from "child_process";
import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import type { IExtensionApi } from "../../types/IExtensionContext";
import { getApplication } from "../../util/application";
import getVortexPath from "../../util/getVortexPath";
import { log } from "../../util/log";
import { getGame } from "../gamemode_management/util/getGame";
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
 * Vortex closes, as they did with links. There is one helper per game folder for the user:
 * whichever Vortex deploys last takes the mount over. A deploy unmounts first, so that the deployment reads
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
  /** The Vortex version whose addon the helper loaded: a native addon cannot be swapped. */
  version?: string;
  error?: string;
}

/**
 * Per user, not per Vortex profile or package: a game folder has one mount, whichever Vortex
 * deployed it last, as it had one set of links. `VORTEX_VFS_MOUNTS_DIR` overrides it (tests).
 */
const mountsDir = () =>
  process.env.VORTEX_VFS_MOUNTS_DIR ??
  path.join(os.userInfo().homedir, ".local", "state", "vortex", "vfs-mounts");

/** The helper folder of `gameId`'s mount at its discovered location. */
function helperDir(api: IExtensionApi, gameId: string): string | undefined {
  const gamePath = api.getState().settings.gameMode.discovered[gameId]?.path;
  if (gamePath === undefined) {
    return undefined;
  }
  const key = createHash("sha256").update(path.resolve(gamePath)).digest("hex").slice(0, 16);
  return path.join(mountsDir(), `${gameId}-${key}`);
}

/** How long a helper may go without touching its status before it counts as gone. */
const HEARTBEAT_LIMIT_MS = 6000;

/**
 * The helper's status while it runs. It touches the file every two seconds and removes it when
 * it ends; a status left by a helper that died goes stale. (A Flatpak helper runs in its own
 * sandbox, whose process ids mean nothing here.)
 */
function liveStatus(dir: string | undefined): IHelperStatus | undefined {
  if (dir === undefined) {
    return undefined;
  }
  try {
    const file = path.join(dir, "status.json");
    if (Date.now() - fs.statSync(file).mtimeMs > HEARTBEAT_LIMIT_MS) {
      return undefined;
    }
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** This Vortex profile, which a spec names: another profile's mount is not this one's. */
const owner = () => getVortexPath("userData");

/** Whether `gameId`'s helper is up and serving this profile's deployment. */
export function isMounted(api: IExtensionApi, gameId: string): boolean {
  const dir = helperDir(api, gameId);
  if (liveStatus(dir)?.mounted !== true) {
    return false;
  }
  try {
    return JSON.parse(fs.readFileSync(path.join(dir!, "spec.json"), "utf8")).owner === owner();
  } catch {
    return false;
  }
}

/** The environment a helper runs in: Vortex's own Electron as Node, and FUSE's helper. */
const helperEnv = (): Record<string, string> => ({
  ELECTRON_RUN_AS_NODE: "1",
  ...(process.env.FUSERMOUNT_PATH !== undefined
    ? { FUSERMOUNT_PATH: process.env.FUSERMOUNT_PATH }
    : {}),
});

/**
 * How to start `dir`'s helper so that it outlives Vortex. Everything a Flatpak app starts ends
 * with it; a process the portal starts in a new sandbox of the same app does not. An AppImage's
 * files are in a mount that ends with Vortex, so the AppImage itself starts the helper, with a
 * mount of its own.
 */
function helperCommand(dir: string): [string, string[]] {
  const helper = path.join(dir, "helper.cjs");
  if (isFlatpak()) {
    const env = Object.entries(helperEnv()).map(([name, value]) => `--env=${name}=${value}`);
    return ["flatpak-spawn", [...env, process.execPath, helper, dir]];
  }
  return [process.env.APPIMAGE ?? process.execPath, [helper, dir]];
}

/** Start a helper for `dir`, detached, so that it outlives Vortex. */
function startHelper(dir: string): void {
  fs.writeFileSync(path.join(dir, "helper.cjs"), MOUNT_HELPER_SOURCE);
  const [command, args] = helperCommand(dir);
  const output = fs.openSync(path.join(dir, "helper.log"), "a");
  try {
    spawn(command, args, {
      detached: true,
      stdio: ["ignore", output, output],
      env: { ...process.env, ...helperEnv() },
    }).unref();
  } finally {
    fs.closeSync(output);
  }
}

/** The autostart entry that mounts `dir`'s folder again at login, as links survived a restart. */
const loginEntry = (dir: string) =>
  path.join(
    process.env.VORTEX_VFS_AUTOSTART_DIR ??
      path.join(
        // A Flatpak's XDG_CONFIG_HOME is its own; the session reads the user's.
        (isFlatpak() ? undefined : process.env.XDG_CONFIG_HOME) ??
          path.join(os.userInfo().homedir, ".config"),
        "autostart",
      ),
    `vortex-vfs-${path.basename(dir)}.desktop`,
  );

/** A desktop entry argument: quoted, with what quoting and field codes need escaped. */
const desktopArg = (arg: string) => `"${arg.replace(/(["`$\\])/g, "\\$1").replace(/%/g, "%%")}"`;

function writeLoginEntry(dir: string, gameName: string): void {
  const [command, args] = helperCommand(dir);
  const exec = isFlatpak()
    ? // flatpak-spawn needs a running app; the login session starts one.
      [
        "flatpak",
        "run",
        ...Object.entries(helperEnv()).map(([name, value]) => `--env=${name}=${value}`),
        `--command=${process.execPath}`,
        process.env.FLATPAK_ID ?? "com.nexusmods.vortex",
        ...args.slice(-2),
      ]
    : [
        "env",
        ...Object.entries(helperEnv()).map(([name, value]) => `${name}=${value}`),
        command,
        ...args,
      ];
  const entry = loginEntry(dir);
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(
    entry,
    [
      "[Desktop Entry]",
      "Type=Application",
      `Name=Vortex mods for ${gameName}`,
      `Comment=Shows the mods Vortex deployed in ${gameName}'s folder`,
      `Exec=${exec.map(desktopArg).join(" ")}`,
      "NoDisplay=true",
      "Terminal=false",
      "X-GNOME-Autostart-enabled=true",
      "",
    ].join("\n"),
  );
}

/** Remove `dir`'s spec, which unmounts, and wait for its helper to end. */
async function stopHelper(gameId: string, dir: string): Promise<void> {
  const running = liveStatus(dir) !== undefined;
  fs.rmSync(path.join(dir, "spec.json"), { force: true });
  fs.rmSync(loginEntry(dir), { force: true });
  if (!running) {
    return;
  }
  for (let waited = 0; liveStatus(dir) !== undefined; waited += 100) {
    if (waited >= 15000) {
      log("error", "the mount helper did not unmount", { gameId });
      return;
    }
    await delay(100);
  }
  log("info", "unmounted the virtual file system", { gameId });
}

/** Mount `gameId`'s deployment as its manifests describe it, or update the mount it has. */
export async function mountGame(api: IExtensionApi, gameId: string): Promise<void> {
  if (!mountsApply()) {
    return;
  }
  const mine = bump(gameId);
  const aether = loadAether();
  const game = await deploymentForGame(api, gameId);
  const dir = helperDir(api, gameId);
  if (
    aether === undefined ||
    game === undefined ||
    dir === undefined ||
    generations.get(gameId) !== mine
  ) {
    return;
  }
  const version = getApplication().version;
  const running = liveStatus(dir);
  if (running !== undefined && running.version !== version) {
    // Mounted by another Vortex version, whose addon stays loaded in its helper.
    await stopHelper(gameId, dir);
    if (generations.get(gameId) !== mine) {
      return;
    }
  }
  fs.mkdirSync(dir, { recursive: true });
  useHostFusermount();
  const generation = Date.now() * 1000 + mine;
  const spec = {
    owner: owner(),
    version,
    addon: aether.addon,
    stateDir: path.join(dir, "state"),
    roots: gameRoots(game),
    generation,
  };
  const specFile = path.join(dir, "spec.json");
  fs.writeFileSync(`${specFile}.tmp`, JSON.stringify(spec));
  fs.renameSync(`${specFile}.tmp`, specFile);
  if (liveStatus(dir) === undefined) {
    startHelper(dir);
  }
  for (let waited = 0; waited < 15000; waited += 100) {
    const status = liveStatus(dir);
    if (status?.generation === generation) {
      if (status.mounted) {
        log("info", "mounted the virtual file system", { gameId, pid: status.pid });
        writeLoginEntry(dir, getGame(gameId)?.name ?? gameId);
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
export async function unmountGame(api: IExtensionApi, gameId: string): Promise<void> {
  bump(gameId);
  const dir = helperDir(api, gameId);
  if (dir !== undefined) {
    await stopHelper(gameId, dir);
  }
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
 * Where a file of a Flatpak app (`/app/...`) is on the host: under the app's files, which
 * `/.flatpak-info` names (`app-path`, the installed commit). The branch's `active` link is used
 * instead of the commit, so that the path survives an update of the app.
 */
export function flatpakHostPath(flatpakInfo: string, inside: string): string | undefined {
  const appPath = /^app-path=(.+)$/m.exec(flatpakInfo)?.[1]?.trim();
  if (appPath === undefined || !inside.startsWith("/app/")) {
    return undefined;
  }
  const files = path.posix.join(path.posix.dirname(path.posix.dirname(appPath)), "active", "files");
  return path.posix.join(files, path.posix.relative("/app", inside));
}

/** A word for sh, whatever it holds. */
const shellWord = (word: string) => `'${word.replace(/'/g, `'\\''`)}'`;

/**
 * The `$FUSERMOUNT_PATH` of a Flatpak Vortex. The sandbox has no `/dev/fuse` and cannot mount:
 * the host's `fusermount3` mounts, sending the FUSE device back over the socket aether-vfs
 * forwards (`_FUSE_COMMFD`). Ubuntu's AppArmor profile for `fusermount3` refuses a socket from
 * inside the sandbox, so aether-vfs's `fusermount-relay` runs on the host (a static program in
 * the app's files), gives `fusermount3` a socket of its own and passes the device on. Unmounting
 * needs no socket.
 */
export function hostFusermountScript(relay: string | undefined): string {
  const mount = relay === undefined ? "fusermount3" : shellWord(relay);
  return [
    "#!/bin/sh",
    'if [ -n "$_FUSE_COMMFD" ]; then',
    `  exec flatpak-spawn --host --forward-fd="$_FUSE_COMMFD" --env=_FUSE_COMMFD="$_FUSE_COMMFD" ${mount} "$@"`,
    "fi",
    'exec flatpak-spawn --host fusermount3 "$@"',
    "",
  ].join("\n");
}

/** Point aether-vfs at the host's FUSE helper (above), in a Flatpak. */
function useHostFusermount(): void {
  if (!isFlatpak() || process.env.FUSERMOUNT_PATH !== undefined) {
    return;
  }
  let relay: string | undefined;
  const inside = loadAether()?.dir;
  if (inside !== undefined && fs.existsSync(path.join(inside, "fusermount-relay"))) {
    try {
      relay = flatpakHostPath(
        fs.readFileSync("/.flatpak-info", "utf8"),
        path.join(inside, "fusermount-relay"),
      );
    } catch {
      relay = undefined;
    }
  }
  // Beside the helpers, which a Flatpak helper sandbox shares (its /tmp is its own).
  const wrapper = path.join(mountsDir(), "host-fusermount3");
  fs.mkdirSync(path.dirname(wrapper), { recursive: true });
  fs.writeFileSync(wrapper, hostFusermountScript(relay), { mode: 0o755 });
  fs.chmodSync(wrapper, 0o755);
  process.env.FUSERMOUNT_PATH = wrapper;
}
