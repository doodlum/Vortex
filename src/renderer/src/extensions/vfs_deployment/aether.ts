import * as fs from "fs";
import * as path from "path";

import { getErrorMessageOrDefault } from "@vortex/shared";

import getVortexPath from "../../util/getVortexPath";
import { log } from "../../util/log";

declare const __non_webpack_require__: NodeJS.Require;

/** One file of a root: where programs see it, and the staging file that holds its bytes. */
export interface IAetherFile {
  path: string;
  source: string;
}

export interface IAetherRoot {
  /** Where programs see the root: a real directory (the game folder) that is not changed. */
  location: string;
  /** Served read-only underneath `files`. */
  base?: string;
  files: IAetherFile[];
  /** Where programs' new and changed files land. */
  writeTo?: string;
}

export interface IAetherLaunchEnd {
  kind: "exited" | "stopped";
  code?: number;
}

export interface IAetherLaunch {
  readonly pid: number;
  readonly notes: string[];
  isRunning(): boolean;
  wait(): Promise<IAetherLaunchEnd>;
  stop(): void;
}

export interface IAetherLaunchOptions {
  image: string;
  args?: string[];
  env?: Record<string, string>;
  envRemove?: string[];
  stageAlso?: string[];
}

export interface IAetherSession {
  start(): void;
  roots(): Array<{ id: number; location: string; files: number }>;
  launch(opts: IAetherLaunchOptions): Promise<IAetherLaunch>;
  close(): void;
}

interface IAetherModule {
  Session: new (opts: {
    stateDir: string;
    artifactsDir: string;
    roots: IAetherRoot[];
  }) => IAetherSession;
}

export interface IAether {
  /** The directory holding the addon, the shim DLL and (under Proton) the injector. */
  dir: string;
  createSession(stateDir: string, roots: IAetherRoot[]): IAetherSession;
}

const ADDON = "aether_vfs_node.node";

/** Where aether-vfs is installed: `VORTEX_AETHER_VFS_DIR`, else beside Vortex's other natives. */
export function aetherCandidates(): string[] {
  const candidates: string[] = [];
  if (process.env.VORTEX_AETHER_VFS_DIR) {
    candidates.push(process.env.VORTEX_AETHER_VFS_DIR);
  }
  candidates.push(path.join(getVortexPath("assets_unpacked"), "aether-vfs"));
  return candidates;
}

let loaded: IAether | undefined;
let loadError: string | undefined;

/** The aether-vfs addon, loaded once. `undefined` when it is missing or fails to load. */
export function loadAether(): IAether | undefined {
  if (loaded !== undefined || loadError !== undefined) {
    return loaded;
  }
  const dir = aetherCandidates().find((candidate) => fs.existsSync(path.join(candidate, ADDON)));
  if (dir === undefined) {
    loadError = `${ADDON} was not found in ${aetherCandidates().join(", ")}`;
    log("warn", "virtual file system unavailable", { reason: loadError });
    return undefined;
  }
  try {
    const addon = __non_webpack_require__(path.join(dir, ADDON)) as IAetherModule;
    loaded = {
      dir,
      createSession: (stateDir, roots) => new addon.Session({ stateDir, artifactsDir: dir, roots }),
    };
    log("info", "virtual file system loaded", { dir });
  } catch (err) {
    loadError = getErrorMessageOrDefault(err);
    log("error", "virtual file system failed to load", { dir, error: loadError });
  }
  return loaded;
}

/** Why `loadAether` returned nothing, for the deployment method's unavailable reason. */
export function aetherLoadError(): string | undefined {
  loadAether();
  return loadError;
}

/** The stable code an aether-vfs rejection carries (`E_CONFIG: …`), if any. */
export function aetherErrorCode(err: unknown): string | undefined {
  const message = getErrorMessageOrDefault(err);
  return /^(E_[A-Z]+): /.exec(message)?.[1];
}
