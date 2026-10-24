import * as fs from "fs";
import * as path from "path";

import type { IState } from "../../types/IState";
import { getGame } from "../gamemode_management/util/getGame";
import type { IUnavailableReason } from "../mod_management/types/IDeploymentMethod";
import { aetherLoadError, loadAether } from "./aether";
import { canMount } from "./mounts";

export type ImageArch = "x64" | "x86" | "other";

const IMAGE_FILE_MACHINE_I386 = 0x14c;
const IMAGE_FILE_MACHINE_AMD64 = 0x8664;

const archCache = new Map<string, { mtimeMs: number; arch: ImageArch | undefined }>();

/**
 * The machine a Windows executable is built for, from its PE header. `undefined` when the file
 * is missing or is not a PE image. Read synchronously (a support check is synchronous) and
 * cached until the file changes.
 */
export function imageArch(filePath: string): ImageArch | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return undefined;
  }
  const cached = archCache.get(filePath);
  if (cached !== undefined && cached.mtimeMs === stat.mtimeMs) {
    return cached.arch;
  }
  let arch: ImageArch | undefined;
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, "r");
    const header = Buffer.alloc(4096);
    const read = fs.readSync(fd, header, 0, header.length, 0);
    if (read >= 0x40 && header.toString("latin1", 0, 2) === "MZ") {
      const peOffset = header.readUInt32LE(0x3c);
      if (peOffset + 6 <= read && header.toString("latin1", peOffset, peOffset + 4) === "PE\0\0") {
        const machine = header.readUInt16LE(peOffset + 4);
        arch =
          machine === IMAGE_FILE_MACHINE_AMD64
            ? "x64"
            : machine === IMAGE_FILE_MACHINE_I386
              ? "x86"
              : "other";
      }
    }
  } catch {
    arch = undefined;
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
  archCache.set(filePath, { mtimeMs: stat.mtimeMs, arch });
  return arch;
}

/** The game's main executable as discovered, or as its extension names it. */
export function gameExecutable(state: IState, gameId: string): string | undefined {
  const discovery = state.settings.gameMode.discovered[gameId];
  if (discovery?.path === undefined) {
    return undefined;
  }
  try {
    const relative = discovery.executable ?? getGame(gameId)?.executable(discovery.path);
    return relative === undefined ? undefined : path.resolve(discovery.path, relative);
  } catch {
    return undefined;
  }
}

/**
 * Linux mounts the game's folders (FUSE), so any game works, native or under Proton; the
 * machine needs FUSE, and a Flatpak Vortex cannot mount from its sandbox yet.
 */
function linuxSupport(state: IState, gameId: string): IUnavailableReason | undefined {
  if (process.env.IS_FLATPAK === "true") {
    return {
      description: (t) =>
        t("The virtual file system cannot mount game folders from the Flatpak sandbox yet."),
    };
  }
  const loadError = aetherLoadError();
  if (loadError !== undefined) {
    return {
      description: (t) =>
        t("The virtual file system could not be loaded: {{error}}", {
          replace: { error: loadError },
        }),
      solution: (t) => t("Reinstall Vortex to restore its virtual file system files."),
    };
  }
  if (!canMount()) {
    return {
      description: (t) =>
        t("FUSE, which the virtual file system mounts game folders with, is missing."),
      solution: (t) => t("Install your distribution's fuse3 package, then restart Vortex."),
    };
  }
  if (state.settings.gameMode.discovered[gameId]?.path === undefined) {
    return { description: (t) => t("The game has not been found yet.") };
  }
  return undefined;
}

/** Whether the virtual file system can serve `gameId`; `undefined` when it can. */
export function vfsSupport(state: IState, gameId: string): IUnavailableReason | undefined {
  if (process.platform === "linux") {
    return linuxSupport(state, gameId);
  }
  if (process.platform !== "win32") {
    return {
      description: (t) => t("The virtual file system is not available on this platform yet."),
    };
  }
  const loadError = aetherLoadError();
  if (loadError !== undefined) {
    return {
      description: (t) =>
        t("The virtual file system could not be loaded: {{error}}", {
          replace: { error: loadError },
        }),
      solution: (t) => t("Reinstall Vortex to restore its virtual file system files."),
    };
  }
  const executable = gameExecutable(state, gameId);
  if (executable === undefined) {
    return { description: (t) => t("The game has not been found yet.") };
  }
  if (state.settings.gameMode.discovered[gameId]?.store === "xbox") {
    // The store starts its games inside their app container, where no program Vortex starts
    // (and so no session) can reach them.
    return {
      description: (t) =>
        t(
          "Microsoft Store games are started inside their app container, which the virtual " +
            "file system cannot reach.",
        ),
    };
  }
  const arch = imageArch(executable);
  if (arch === "x64") {
    return undefined;
  }
  if (arch === "x86") {
    // A 32-bit game gets the 32-bit shim (and its injector) from the `x86` folder beside the
    // 64-bit one (aether-vfs's X86_ARTIFACTS_DIR).
    const dir = loadAether()?.dir;
    if (dir !== undefined && fs.existsSync(path.join(dir, "x86", "vfs_shim_dll.dll"))) {
      return undefined;
    }
    return {
      description: (t) => t("The virtual file system's 32-bit files are missing."),
      solution: (t) => t("Reinstall Vortex to restore its virtual file system files."),
    };
  }
  return {
    description: (t) =>
      t("{{file}} is not a 64-bit Windows program the virtual file system can run.", {
        replace: { file: path.basename(executable) },
      }),
  };
}
