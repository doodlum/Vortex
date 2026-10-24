/**
 * Shows Vortex itself, and every extension, game folders as the programs it launches see them
 * when a game is deployed through the virtual file system: Node's `fs` and `fs/promises` are
 * wrapped so that reads (`readFile`, `open` for reading, `createReadStream`, `stat`, `lstat`,
 * `access`, `exists`, `readdir`) under a virtual deployment's folders resolve to the staged
 * files that serve them, and listings include them. Writes are not redirected.
 *
 * Installed at the very start of the renderer, before `graceful-fs` and `fs-extra` copy `fs`'s
 * functions, so code that reads the game folder needs no change. Code that must see the real
 * disk (building merged files from the game's originals) uses `realFs`.
 *
 * The index is synchronous because the synchronous calls need an answer at once: the
 * deployment extension hands it every virtual file (deployed path and staged source) whenever
 * a virtual deployment changes.
 */
import type * as fsType from "fs";
import * as path from "path";

declare const __non_webpack_require__: NodeJS.Require | undefined;

export interface IVirtualFile {
  /** Where programs see the file. */
  deployed: string;
  /** The real file that holds it. */
  source: string;
}

interface IDirEntry {
  name: string;
  isDir: boolean;
}

interface IIndex {
  files: Map<string, string>;
  /** Folded directory -> its virtual children (files and directories), by folded name. */
  dirs: Map<string, Map<string, IDirEntry>>;
  /** A real directory to report for a directory only mods provide. */
  anchor: Map<string, string>;
}

const caseInsensitive = process.platform === "win32";
const fold = (input: string) =>
  caseInsensitive ? path.resolve(input).toLowerCase() : path.resolve(input);
const foldName = (name: string) => (caseInsensitive ? name.toLowerCase() : name);

const indexes = new Map<string, { roots: string[]; files: IVirtualFile[] }>();
let index: IIndex = { files: new Map(), dirs: new Map(), anchor: new Map() };

function rebuild() {
  const next: IIndex = { files: new Map(), dirs: new Map(), anchor: new Map() };
  for (const { roots, files } of indexes.values()) {
    for (const file of files) {
      next.files.set(fold(file.deployed), file.source);
      // Every ancestor up to the root that holds it lists the child below it.
      const root = roots.find((candidate) => isUnder(fold(candidate), fold(file.deployed)));
      let child = path.resolve(file.deployed);
      let isDir = false;
      while (root !== undefined) {
        const parent = path.dirname(child);
        const key = fold(parent);
        const children = next.dirs.get(key) ?? new Map<string, IDirEntry>();
        children.set(foldName(path.basename(child)), { name: path.basename(child), isDir });
        next.dirs.set(key, children);
        next.anchor.set(key, root);
        if (key === fold(root) || parent === child) {
          break;
        }
        child = parent;
        isDir = true;
      }
    }
  }
  index = next;
}

function isUnder(parentFolded: string, childFolded: string) {
  return childFolded === parentFolded || childFolded.startsWith(parentFolded + path.sep);
}

/**
 * Replace one owner's (a game's) virtual files. `roots` are the real directories they are
 * deployed under (the game folder, other targets): listings are merged there and below.
 */
export function setVirtualFiles(owner: string, roots: string[], files: IVirtualFile[]): void {
  if (files.length === 0) {
    indexes.delete(owner);
  } else {
    indexes.set(owner, { roots, files });
  }
  rebuild();
}

/** The staged file behind `filePath`, if a virtual deployment serves it. */
export function virtualSource(filePath: string): string | undefined {
  return index.files.get(fold(filePath));
}

function virtualChildren(dirPath: string): Map<string, IDirEntry> | undefined {
  return index.dirs.get(fold(dirPath));
}

type AnyFn = (...args: any[]) => any;

/** The unwrapped functions, for code that must see the real disk. */
export const realFs = { promises: {} } as unknown as Record<string, AnyFn | undefined> & {
  promises: Record<string, AnyFn | undefined>;
};

function nodeFs(): typeof fsType {
  // The real module: webpack's own `require` would hand back a bundled stand-in in tests.
  const req = typeof __non_webpack_require__ === "function" ? __non_webpack_require__ : require;
  return req("fs");
}

/** `[mapped path, directory anchor]` for a path argument. */
function redirect(input: unknown): { target: unknown; dirAnchor?: string } {
  if (typeof input !== "string") {
    return { target: input };
  }
  const source = virtualSource(input);
  if (source !== undefined) {
    return { target: source };
  }
  const anchor = index.anchor.get(fold(input));
  return { target: input, dirAnchor: anchor };
}

function makeDirent(fs: typeof fsType, parent: string, entry: IDirEntry): fsType.Dirent {
  const dirent = Object.create(fs.Dirent.prototype) as fsType.Dirent & Record<string, unknown>;
  Object.defineProperties(dirent, {
    name: { value: entry.name, enumerable: true },
    parentPath: { value: parent, enumerable: true },
    path: { value: parent, enumerable: true },
    isFile: { value: () => !entry.isDir },
    isDirectory: { value: () => entry.isDir },
    isSymbolicLink: { value: () => false },
    isBlockDevice: { value: () => false },
    isCharacterDevice: { value: () => false },
    isFIFO: { value: () => false },
    isSocket: { value: () => false },
  });
  return dirent;
}

/** A real listing with a virtual deployment's entries merged in, names or Dirents. */
function mergeListing(
  fs: typeof fsType,
  dirPath: string,
  real: Array<string | fsType.Dirent> | undefined,
  virtual: Map<string, IDirEntry>,
  withFileTypes: boolean,
): Array<string | fsType.Dirent> {
  const out = new Map<string, string | fsType.Dirent>();
  for (const entry of real ?? []) {
    out.set(foldName(typeof entry === "string" ? entry : entry.name), entry);
  }
  for (const [key, entry] of virtual) {
    if (withFileTypes) {
      out.set(key, makeDirent(fs, dirPath, entry));
    } else if (!out.has(key)) {
      out.set(key, entry.name);
    }
  }
  return Array.from(out.values());
}

function readdirOptions(args: unknown[]): boolean {
  const options = args[1];
  return typeof options === "object" && options !== null && (options as any).withFileTypes === true;
}

let installed = false;

/** Wrap `fs` and `fs/promises`. Idempotent. */
export function install(fs: typeof fsType = nodeFs()): void {
  if (installed) {
    return;
  }
  installed = true;
  const promises = fs.promises as unknown as Record<string, AnyFn>;
  const sync = fs as unknown as Record<string, AnyFn>;

  const wrapPath = (name: string, onDirAnchor: boolean) => {
    const original = sync[name];
    if (typeof original !== "function") return;
    realFs[name] = original;
    sync[name] = function (this: unknown, input: unknown, ...rest: unknown[]) {
      const { target, dirAnchor } = redirect(input);
      return original.call(
        this,
        onDirAnchor && dirAnchor ? (realExists(fs, input) ? input : dirAnchor) : target,
        ...rest,
      );
    };
  };
  const wrapPromisePath = (name: string, onDirAnchor: boolean) => {
    const original = promises[name];
    if (typeof original !== "function") return;
    realFs.promises[name] = original;
    promises[name] = function (this: unknown, input: unknown, ...rest: unknown[]) {
      const { target, dirAnchor } = redirect(input);
      return original.call(
        this,
        onDirAnchor && dirAnchor ? (realExists(fs, input) ? input : dirAnchor) : target,
        ...rest,
      );
    };
  };

  // Reads of a file: the staged source. Stat-like calls also answer for a directory only mods
  // provide, with the real directory it sits in.
  for (const name of ["readFile", "readFileSync", "createReadStream"]) wrapPath(name, false);
  for (const name of [
    "stat",
    "statSync",
    "lstat",
    "lstatSync",
    "access",
    "accessSync",
    "exists",
    "existsSync",
  ]) {
    wrapPath(name, true);
  }
  for (const name of ["readFile"]) wrapPromisePath(name, false);
  for (const name of ["stat", "lstat", "access"]) wrapPromisePath(name, true);

  // A mod's deployed file is its staged file, as it was with a hard link: opening it (for
  // reading or writing), writing it, or changing its times or size reaches the staged file.
  // A new file is created on the real disk, as before.
  for (const name of [
    "open",
    "openSync",
    "writeFile",
    "writeFileSync",
    "appendFile",
    "appendFileSync",
    "utimes",
    "utimesSync",
    "truncate",
    "truncateSync",
    "createWriteStream",
  ]) {
    wrapPath(name, false);
  }
  for (const name of ["open", "writeFile", "appendFile", "utimes", "truncate"]) {
    wrapPromisePath(name, false);
  }
  // Listings: merged.
  const readdir = sync.readdir;
  const readdirSync = sync.readdirSync;
  const readdirPromise = promises.readdir;
  realFs.readdir = readdir;
  realFs.readdirSync = readdirSync;
  realFs.promises.readdir = readdirPromise;
  sync.readdirSync = function (this: unknown, ...args: unknown[]) {
    const virtual = typeof args[0] === "string" ? virtualChildren(args[0]) : undefined;
    if (virtual === undefined) return readdirSync.apply(this, args);
    let real: Array<string | fsType.Dirent> | undefined;
    try {
      real = readdirSync.apply(this, args);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    return mergeListing(fs, args[0] as string, real, virtual, readdirOptions(args));
  };
  sync.readdir = function (this: unknown, ...args: unknown[]) {
    const callback = args[args.length - 1] as AnyFn;
    const virtual = typeof args[0] === "string" ? virtualChildren(args[0]) : undefined;
    if (virtual === undefined || typeof callback !== "function") return readdir.apply(this, args);
    return readdir.call(
      this,
      ...args.slice(0, -1),
      (err: NodeJS.ErrnoException | null, real?: unknown[]) => {
        if (err && err.code !== "ENOENT") return callback(err);
        callback(
          null,
          mergeListing(fs, args[0] as string, real as any, virtual, readdirOptions(args)),
        );
      },
    );
  };
  promises.readdir = async function (this: unknown, ...args: unknown[]) {
    const virtual = typeof args[0] === "string" ? virtualChildren(args[0]) : undefined;
    if (virtual === undefined) return readdirPromise.apply(this, args);
    let real: Array<string | fsType.Dirent> | undefined;
    try {
      real = await readdirPromise.apply(this, args);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    return mergeListing(fs, args[0] as string, real, virtual, readdirOptions(args));
  };
}

/** `stat` of the real disk, past any virtual deployment. */
export function realStat(filePath: string): Promise<fsType.Stats> {
  const fs = nodeFs();
  const stat = (realFs.promises.stat ?? fs.promises.stat) as (p: string) => Promise<fsType.Stats>;
  return stat.call(fs.promises, filePath);
}

function realExists(fs: typeof fsType, input: unknown): boolean {
  const existsSync = (realFs.existsSync ?? fs.existsSync) as (p: unknown) => boolean;
  return existsSync(input);
}
