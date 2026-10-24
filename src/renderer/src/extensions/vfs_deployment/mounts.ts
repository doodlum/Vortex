import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

import { getErrorMessageOrDefault } from "@vortex/shared";

import type { IExtensionApi } from "../../types/IExtensionContext";
import getVortexPath from "../../util/getVortexPath";
import { log } from "../../util/log";
import { aetherErrorCode, type IAetherSession, loadAether } from "./aether";
import { deploymentForGame, gameRoots } from "./roots";

/**
 * Linux: a game deployed through the virtual file system has its roots mounted at their real
 * locations (FUSE) for as long as Vortex runs. Every program sees the mods there with no help:
 * the game started by Vortex or by Steam's own Play button, tools, and Vortex itself. What
 * programs write lands in the roots' write folders, as on Windows.
 *
 * A deploy unmounts first, so that the deployment reads the game's own files (merging from
 * originals, say), and mounts the new deployment when it is done. A purge unmounts.
 */
const mounts = new Map<string, IAetherSession>();
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

export function isMounted(gameId: string): boolean {
  return mounts.has(gameId);
}

/** Mount `gameId`'s deployment as its manifests describe it, replacing a mount it has. */
export async function mountGame(api: IExtensionApi, gameId: string): Promise<void> {
  if (!mountsApply()) {
    return;
  }
  unmountGame(gameId);
  const mine = bump(gameId);
  const aether = loadAether();
  const game = await deploymentForGame(api, gameId);
  if (aether === undefined || game === undefined || generations.get(gameId) !== mine) {
    return;
  }
  const stateDir = path.join(getVortexPath("temp"), "vfs-mounts", `${gameId}-${process.pid}`);
  try {
    useHostFusermount();
    const session = aether.createSession(stateDir, gameRoots(game));
    session.start();
    mounts.set(gameId, session);
    log("info", "mounted the virtual file system", { gameId, roots: session.roots() });
  } catch (err) {
    log("error", "failed to mount the virtual file system", {
      gameId,
      code: aetherErrorCode(err),
      error: getErrorMessageOrDefault(err),
    });
    api.showErrorNotification("The game cannot see its mods", err, {
      allowReport: aetherErrorCode(err) === "E_INTERNAL",
      message: "Mounting the virtual file system failed.",
    });
  }
}

/** Unmount `gameId`'s deployment (lazily, if a program still holds files there). */
export function unmountGame(gameId: string): void {
  bump(gameId);
  const session = mounts.get(gameId);
  if (session === undefined) {
    return;
  }
  mounts.delete(gameId);
  try {
    session.close();
    log("info", "unmounted the virtual file system", { gameId });
  } catch (err) {
    log("warn", "failed to unmount the virtual file system", {
      gameId,
      error: getErrorMessageOrDefault(err),
    });
  }
}

export function unmountAll(): void {
  for (const gameId of Array.from(mounts.keys())) {
    unmountGame(gameId);
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
 * A Flatpak Vortex mounts through the host's `fusermount3`: the sandbox has none and cannot
 * mount. aether-vfs runs `$FUSERMOUNT_PATH`, which forwards the socket the FUSE device comes
 * back on (`_FUSE_COMMFD`) to the host helper. The mount is then made on the host, where the
 * games and Steam run; Vortex itself sees the deployment through its file view.
 */
function useHostFusermount(): void {
  if (!isFlatpak() || process.env.FUSERMOUNT_PATH !== undefined) {
    return;
  }
  const wrapper = path.join(getVortexPath("temp"), "vfs-host-fusermount3");
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
