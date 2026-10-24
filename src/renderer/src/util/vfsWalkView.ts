/**
 * The `turbowalk` half of `vfsFsView`: directory walks under a virtual deployment's folders
 * list the files it serves (with their staged files' sizes and times) and the folders only
 * mods provide, and a mod's file replaces the game file of the same path. Vortex and every
 * extension import `turbowalk` from the one module instance this wraps, so their walks need no
 * change.
 *
 * `turbowalk` is wrapped when it is first loaded, not here: its module replaces the global
 * `Promise` with Bluebird, and Vortex's startup depends on when that happens.
 *
 * A walk that asks for directory terminators gets the real disk only: the one caller (game
 * discovery) looks for game executables, which a deployment does not provide.
 */
import * as fsModule from "fs";
import type * as fsType from "fs";
import * as path from "path";

import Bluebird from "bluebird";
import type { IEntry, IWalkOptions } from "turbowalk";

import { isHidden, realFs, virtualEntriesUnder, virtualSource } from "./vfsFsView";

declare const __non_webpack_require__: NodeJS.Require | undefined;

/** Node's own module, which webpack's `require` would replace with a bundled stand-in. */
function nodeRequire(id: string): unknown {
  if (typeof __non_webpack_require__ !== "function") {
    throw new Error(`${id} can only be loaded in the app`);
  }
  return __non_webpack_require__(id);
}

type Walk = (
  walkPath: string,
  progress: ((entries: IEntry[]) => void) | undefined,
  options?: IWalkOptions,
  setCancel?: (cancel: () => void) => void,
) => PromiseLike<void>;

interface IWalkModule {
  default: Walk;
}

const caseInsensitive = process.platform === "win32";
const fold = (input: string) =>
  caseInsensitive ? path.resolve(input).toLowerCase() : path.resolve(input);

function realStatSync(filePath: string): fsType.Stats | undefined {
  const statSync = (realFs.statSync ?? fsModule.statSync) as (p: string) => fsType.Stats;
  try {
    return statSync(filePath);
  } catch {
    return undefined;
  }
}

/** Wrap a walk function so its results include virtual deployments. */
export function viewWalk(walk: Walk): Walk {
  const wrapped: Walk = (walkPath, progress, options, setCancel) => {
    const opts = options ?? {};
    const virtual =
      typeof walkPath === "string" && opts.terminators !== true
        ? virtualEntriesUnder(walkPath, opts.recurse !== false)
        : [];
    if (virtual.length === 0) {
      return walk(walkPath, progress, options, setCancel);
    }
    const served = new Set(virtual.filter((e) => !e.isDirectory).map((e) => fold(e.filePath)));
    const seenDirs = new Set<string>();
    let cancelled = false;
    const realProgress = (entries: IEntry[]) => {
      const kept = entries.filter((entry) => {
        const key = fold(entry.filePath);
        if (isHidden(entry.filePath)) {
          // Deleted by a program inside the root: gone, as it is for the game.
          return false;
        }
        if (entry.isDirectory) {
          seenDirs.add(key);
          return true;
        }
        return !served.has(key);
      });
      if (kept.length > 0 && progress !== undefined) {
        progress(kept);
      }
    };
    const ownCancel = (cancel: () => void) => {
      setCancel?.(() => {
        cancelled = true;
        cancel();
      });
    };
    const addVirtual = () => {
      if (cancelled || progress === undefined) {
        return;
      }
      const entries: IEntry[] = [];
      for (const entry of virtual) {
        const key = fold(entry.filePath);
        if (entry.isDirectory) {
          if (seenDirs.has(key)) continue;
          seenDirs.add(key);
          entries.push({
            filePath: entry.filePath,
            isDirectory: true,
            isReparsePoint: false,
            size: 0,
            mtime: 0,
          });
          continue;
        }
        const stats = realStatSync(entry.source ?? virtualSource(entry.filePath) ?? "");
        if (stats === undefined) continue;
        entries.push({
          filePath: entry.filePath,
          isDirectory: false,
          isReparsePoint: false,
          size: stats.size,
          mtime: Math.floor(stats.mtimeMs / 1000),
          ...(opts.details === true
            ? { linkCount: stats.nlink, id: stats.ino, idStr: String(stats.ino) }
            : {}),
        });
      }
      const threshold = Math.max(1, opts.threshold ?? 1024);
      for (let i = 0; i < entries.length && !cancelled; i += threshold) {
        progress(entries.slice(i, i + threshold));
      }
    };
    // A folder only mods provide has nothing on disk to walk.
    if (realStatSync(walkPath) === undefined) {
      // Callers may use Bluebird's methods on a walk's result, as turbowalk returns one.
      return Bluebird.resolve().then(addVirtual);
    }
    return walk(walkPath, realProgress, options, ownCancel).then(addVirtual);
  };
  return wrapped;
}

let installed = false;

const wrappedModules = new WeakSet<IWalkModule>();

/** Wrap a loaded `turbowalk` module's export in place. Idempotent. */
export function wrapWalkModule(walkModule: IWalkModule): void {
  if (walkModule === null || typeof walkModule !== "object" || wrappedModules.has(walkModule)) {
    return;
  }
  wrappedModules.add(walkModule);
  walkModule.default = viewWalk(walkModule.default);
}

/** Wrap `turbowalk` whenever it is loaded (the first load creates the one instance). */
export function installWalk(): void {
  if (installed) {
    return;
  }
  installed = true;
  const loader = nodeRequire("module") as {
    _load: (request: string, ...rest: unknown[]) => unknown;
  };
  const load = loader._load;
  loader._load = function (this: unknown, request: string, ...rest: unknown[]) {
    const result = load.call(this, request, ...rest);
    if (request === "turbowalk") {
      wrapWalkModule(result as IWalkModule);
    }
    return result;
  };
}
