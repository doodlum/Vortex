/**
 * Shows Vortex itself, and every extension, game folders as the programs it launches see them
 * when a game is deployed through the virtual file system: Node's `fs` and `fs/promises` are
 * wrapped so that reads (`readFile`, `open` for reading, `createReadStream`, `stat`, `lstat`,
 * `access`, `exists`, `readdir`) under a virtual deployment's folders resolve to the staged
 * files that serve them, and listings include them. Writes, renames and deletes of a deployed
 * file behave as they did on the hard link it replaces; new files are created on the real disk.
 *
 * Installed at the very start of the renderer, before `graceful-fs` and `fs-extra` copy `fs`'s
 * functions, so code that reads the game folder needs no change. Code that must see the real
 * disk (building merged files from the game's originals) uses `realFs`.
 *
 * The index is synchronous because the synchronous calls need an answer at once: the
 * deployment extension hands it every virtual file (deployed path and staged source) whenever
 * a virtual deployment changes.
 */
import * as fsModule from "fs";
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
  /** Folded deployed path -> the real file that serves it (a staged file or an overwrite file). */
  files: Map<string, string>;
  /** The staged files of the deployment alone, under any overwrite file that hides one. */
  mods: Map<string, string>;
  /** Paths served by a file in a root's write folder: a real file, not a link to staging. */
  real: Set<string>;
  /** Paths a program deleted inside a root (its write folder's `.wh.` markers). */
  hidden: Set<string>;
  /** Folded directory -> its virtual children (files and directories), by folded name. */
  dirs: Map<string, Map<string, IDirEntry>>;
  /** A real directory to report for a directory only mods provide. */
  anchor: Map<string, string>;
  /** Folded root -> the root as given. */
  roots: Map<string, string>;
}

const caseInsensitive = process.platform === "win32";
const fold = (input: string) =>
  caseInsensitive ? path.resolve(input).toLowerCase() : path.resolve(input);
const foldName = (name: string) => (caseInsensitive ? name.toLowerCase() : name);

const emptyIndex = (): IIndex => ({
  files: new Map(),
  mods: new Map(),
  real: new Set(),
  hidden: new Set(),
  dirs: new Map(),
  anchor: new Map(),
  roots: new Map(),
});

const indexes = new Map<string, { roots: string[]; files: IVirtualFile[] }>();
let index: IIndex = emptyIndex();

/** Programs' writes inside a root, as aether-vfs keeps them: the root's write folder. */
interface IOverwrite {
  root: string;
  dir: string;
  /** Folded deployed path -> the file in `dir` that holds it. */
  files: Map<string, string>;
  /** Folded deployed paths a `.wh.` marker in `dir` hides. */
  hidden: Set<string>;
}

/** By folded root. */
const overwrites = new Map<string, IOverwrite>();

/** aether-vfs's markers (vfs-provider): a deleted name, and a copy-up in flight. */
const WHITEOUT_PREFIX = ".wh.";
const COPY_UP_PREFIX = ".cu.";
/** A folder name no game folder has, for the path a deleted file reads as. */
const HIDDEN_FOLDER = "__vortex_vfs_deleted__";

/** List `dir` in the given index (and every ancestor up to `root`), as the parent of `file`. */
function listUnder(target: IIndex, root: string, file: string) {
  let child = path.resolve(file);
  let isDir = false;
  for (;;) {
    const parent = path.dirname(child);
    const key = fold(parent);
    const children = target.dirs.get(key) ?? new Map<string, IDirEntry>();
    children.set(foldName(path.basename(child)), { name: path.basename(child), isDir });
    target.dirs.set(key, children);
    target.anchor.set(key, root);
    if (key === fold(root) || parent === child) {
      break;
    }
    child = parent;
    isDir = true;
  }
}

function rebuild() {
  const next = emptyIndex();
  for (const { roots, files } of indexes.values()) {
    if (files.length === 0) continue;
    for (const root of roots) {
      next.roots.set(fold(root), path.resolve(root));
    }
    for (const file of files) {
      const key = fold(file.deployed);
      next.files.set(key, file.source);
      next.mods.set(key, file.source);
      // Every ancestor up to the root that holds it lists the child below it.
      const root = roots.find((candidate) => isUnder(fold(candidate), key));
      if (root !== undefined) {
        listUnder(next, root, file.deployed);
      }
    }
  }
  // The write folder is the top layer, as in the session: a deletion hides what is below, a
  // written file replaces it.
  for (const overwrite of overwrites.values()) {
    next.roots.set(fold(overwrite.root), path.resolve(overwrite.root));
    for (const key of overwrite.hidden) {
      next.files.delete(key);
      next.hidden.add(key);
      const parent = path.dirname(key);
      const children = next.dirs.get(parent) ?? new Map<string, IDirEntry>();
      children.delete(path.basename(key));
      // Listed even when empty, so the real listing is filtered there.
      next.dirs.set(parent, children);
      next.anchor.set(parent, overwrite.root);
    }
    for (const [key, file] of overwrite.files) {
      next.files.set(key, file);
      next.real.add(key);
      next.hidden.delete(key);
      listUnder(
        next,
        overwrite.root,
        path.join(overwrite.root, path.relative(overwrite.dir, file)),
      );
    }
  }
  index = next;
}

/**
 * Read a root's write folder: the files programs wrote there, and the `.wh.` markers of what
 * they deleted. A copy-up still in flight is not a file yet.
 */
function scanOverwrite(overwrite: IOverwrite) {
  overwrite.files.clear();
  overwrite.hidden.clear();
  const readdirSync = (realFs.readdirSync ?? fsModule.readdirSync) as typeof fsModule.readdirSync;
  const visit = (dir: string) => {
    let entries: fsType.Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const real = path.join(dir, entry.name);
      const deployed = path.join(overwrite.root, path.relative(overwrite.dir, real));
      if (entry.isDirectory()) {
        visit(real);
      } else if (entry.name.startsWith(WHITEOUT_PREFIX)) {
        overwrite.hidden.add(
          fold(path.join(path.dirname(deployed), entry.name.slice(WHITEOUT_PREFIX.length))),
        );
      } else if (!entry.name.startsWith(COPY_UP_PREFIX)) {
        overwrite.files.set(fold(deployed), real);
      }
    }
  };
  visit(overwrite.dir);
}

/**
 * Show what programs wrote inside `root` (its write folder `dir`) on top of the deployment, or
 * stop showing it (`dir` undefined). The folder is read now; `rescanOverwrites` reads it again
 * once programs that wrote into it have ended.
 */
export function setOverwrite(root: string, dir: string | undefined): void {
  const key = fold(root);
  if (dir === undefined) {
    if (overwrites.delete(key)) rebuild();
    return;
  }
  const overwrite: IOverwrite = {
    root: path.resolve(root),
    dir: path.resolve(dir),
    files: new Map(),
    hidden: new Set(),
  };
  scanOverwrite(overwrite);
  overwrites.set(key, overwrite);
  rebuild();
}

/** Read every root's write folder again (after a program that may have written there ended). */
export function rescanOverwrites(): void {
  for (const overwrite of overwrites.values()) {
    scanOverwrite(overwrite);
  }
  rebuild();
}

export interface IOverwriteEntry {
  /** Where programs see it. */
  deployed: string;
  /** The file in the write folder; undefined for a deletion. */
  file?: string;
}

/** What programs wrote or deleted at `dirPath` and below, from the last read of the folders. */
export function overwriteEntriesUnder(dirPath: string): IOverwriteEntry[] {
  const top = fold(dirPath);
  const out: IOverwriteEntry[] = [];
  for (const overwrite of overwrites.values()) {
    for (const [key, file] of overwrite.files) {
      if (isUnder(top, key)) {
        out.push({ deployed: path.join(overwrite.root, path.relative(overwrite.dir, file)), file });
      }
    }
    for (const key of overwrite.hidden) {
      if (isUnder(top, key)) out.push({ deployed: key });
    }
  }
  return out;
}

/**
 * A deploy restores what it deploys: a program's deletion of one of these files (its `.wh.`
 * marker) is cleared, as redeploying recreated a deleted link. What the user chose to delete
 * for good is no longer deployed, so its marker stays.
 */
export function clearDeletions(deployed: string[]): void {
  const keys = new Set(deployed.map(fold));
  const unlinkSync = (realFs.unlinkSync ?? fsModule.unlinkSync) as typeof fsModule.unlinkSync;
  let any = false;
  for (const overwrite of overwrites.values()) {
    for (const key of Array.from(overwrite.hidden)) {
      if (!keys.has(key)) continue;
      const relative = path.relative(fold(overwrite.root), key);
      try {
        unlinkSync(
          path.join(
            overwrite.dir,
            path.dirname(relative),
            WHITEOUT_PREFIX + path.basename(relative),
          ),
        );
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      overwrite.hidden.delete(key);
      any = true;
    }
  }
  if (any) rebuild();
}

/**
 * The real file that holds what `filePath` shows: for a file a virtual deployment serves, its
 * staged file (or the copy a program wrote over it), otherwise `filePath` itself. For handing
 * a game-folder path to a program Vortex spawns without a session (an archive tool, say),
 * which sees only the real disk.
 */
export function realFilePath(filePath: string): string {
  return virtualSource(filePath) ?? filePath;
}

/** Whether the deployment itself (a mod, not a program's write) has a file at `filePath`. */
export function isModFile(filePath: string): boolean {
  return index.mods.has(fold(filePath));
}

/** Whether a program deleted `filePath` inside a root. */
export function isHidden(filePath: string): boolean {
  return index.hidden.has(fold(filePath));
}

function overwriteAt(filePath: string): IOverwrite | undefined {
  const key = fold(filePath);
  for (const [rootKey, overwrite] of overwrites) {
    if (isUnder(rootKey, key)) return overwrite;
  }
  return undefined;
}

/**
 * A written file left the view (moved or deleted): what it covered shows again, as the session
 * shows it once the write folder no longer has it. Updated in place, not rebuilt: a tool's
 * outputs can be moved into a mod hundreds at a time.
 */
function forgetWritten(key: string) {
  for (const overwrite of overwrites.values()) {
    overwrite.files.delete(key);
  }
  index.real.delete(key);
  const mod = index.mods.get(key);
  if (mod !== undefined) {
    index.files.set(key, mod);
  } else {
    index.files.delete(key);
    index.dirs.get(path.dirname(key))?.delete(path.basename(key));
  }
}

/** A written file arrived at `deployed` (moved within a root): listed in place. */
function noteWritten(overwrite: IOverwrite, deployed: string, file: string) {
  const key = fold(deployed);
  overwrite.files.set(key, file);
  overwrite.hidden.delete(key);
  index.hidden.delete(key);
  index.files.set(key, file);
  index.real.add(key);
  listUnder(index, overwrite.root, deployed);
}

function isUnder(parentFolded: string, childFolded: string) {
  return childFolded === parentFolded || childFolded.startsWith(parentFolded + path.sep);
}

type ChangeListener = (owner: string) => void;
const listeners = new Set<ChangeListener>();

/** Called with the owner whose files changed (deployed, purged, renamed or removed). */
export function onVirtualChange(listener: ChangeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function changed(owners: Iterable<string>) {
  rebuild();
  for (const owner of owners) {
    for (const listener of listeners) {
      try {
        listener(owner);
      } catch {
        // A listener's failure is its own; the view is already updated.
      }
    }
  }
}

/**
 * Replace one owner's (a game's mod type's) virtual files. `roots` are the real directories
 * they are deployed under (the game folder, other targets): listings are merged there and
 * below. An owner with no files is still known, as a deployment with nothing in it; `forget`
 * one that is not deployed virtually at all.
 */
export function setVirtualFiles(owner: string, roots: string[], files: IVirtualFile[]): void {
  indexes.set(owner, { roots, files: [...files] });
  changed([owner]);
}

export function forgetVirtualFiles(owner: string): void {
  if (indexes.delete(owner)) {
    changed([owner]);
  }
}

/** The owners whose key starts with `prefix`, with their roots and files. */
export function virtualDeployments(
  prefix: string,
): Array<{ owner: string; roots: string[]; files: IVirtualFile[] }> {
  return Array.from(indexes.entries())
    .filter(([owner]) => owner.startsWith(prefix))
    .map(([owner, { roots, files }]) => ({ owner, roots, files }));
}

/**
 * A deployed file renamed, as a hard link was: it moves within the view, its staged file stays
 * where it is. Moved out of every root, it becomes a real copy there. Returns false when
 * `from` is not a virtual file.
 */
function moveVirtual(from: string, to: string, fs: typeof fsType): boolean {
  const fromKey = fold(from);
  const toKey = fold(to);
  if (index.real.has(fromKey)) {
    moveWritten(fromKey, to);
    return true;
  }
  for (const [owner, entry] of indexes) {
    const at = entry.files.findIndex((file) => fold(file.deployed) === fromKey);
    if (at < 0) continue;
    const source = entry.files[at].source;
    const touched = new Set([owner]);
    // A rename replaces what was at the target.
    for (const [other, otherEntry] of indexes) {
      const before = otherEntry.files.length;
      otherEntry.files = otherEntry.files.filter((file) => fold(file.deployed) !== toKey);
      if (otherEntry.files.length !== before) touched.add(other);
    }
    const files = entry.files.filter((file) => fold(file.deployed) !== fromKey);
    if (entry.roots.some((root) => isUnder(fold(root), toKey))) {
      files.push({ deployed: path.resolve(to), source });
    } else {
      (realFs.copyFileSync ?? fs.copyFileSync).call(fs, source, to);
    }
    entry.files = files;
    changed(touched);
    return true;
  }
  return false;
}

/**
 * A file a program wrote is a real file, as it was in the game folder: renamed, it moves on
 * disk, within the write folder while it stays inside the root (where the session sees it
 * too) and out of it otherwise (into a mod's folder, say).
 */
function moveWritten(fromKey: string, to: string) {
  const file = index.files.get(fromKey);
  if (file === undefined) return;
  const target = overwriteAt(to);
  const destination =
    target !== undefined ? path.join(target.dir, path.relative(target.root, to)) : to;
  const mkdirSync = (realFs.mkdirSync ?? fsModule.mkdirSync) as typeof fsModule.mkdirSync;
  const renameSync = (realFs.renameSync ?? fsModule.renameSync) as typeof fsModule.renameSync;
  if (target !== undefined) {
    mkdirSync(path.dirname(destination), { recursive: true });
  }
  renameSync(file, destination);
  forgetWritten(fromKey);
  if (target !== undefined) {
    noteWritten(target, to, destination);
  }
}

/**
 * Files programs wrote at `target` or below it are deleted from their write folder, which
 * shows what they covered again (a mod's own file, say: what reverting a game's change to it
 * means). Returns whether there were any.
 */
function removeWritten(target: string): boolean {
  const key = fold(target);
  const unlinkSync = (realFs.unlinkSync ?? fsModule.unlinkSync) as typeof fsModule.unlinkSync;
  let any = false;
  for (const written of Array.from(index.real)) {
    if (!isUnder(key, written)) continue;
    const file = index.files.get(written);
    if (file !== undefined) {
      try {
        unlinkSync(file);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
    forgetWritten(written);
    any = true;
  }
  return any;
}

/** Deployed files at `target` or below it leave the view, as deleted hard links did. */
function removeVirtual(target: string): boolean {
  const key = fold(target);
  // A file a program wrote over a mod's goes first, and alone: the mod's own file shows again.
  if (index.real.has(key)) {
    return removeWritten(target);
  }
  removeWritten(target);
  const touched: string[] = [];
  for (const [owner, entry] of indexes) {
    const files = entry.files.filter((file) => !isUnder(key, fold(file.deployed)));
    if (files.length !== entry.files.length) {
      entry.files = files;
      touched.push(owner);
    }
  }
  if (touched.length > 0) changed(touched);
  return true;
}

/** A staged file or folder was renamed: what it serves follows it, as a hard link did. */
function moveSources(from: string, to: string) {
  const key = fold(from);
  const prefixLength = path.resolve(from).length;
  const target = path.resolve(to);
  const touched: string[] = [];
  for (const [owner, entry] of indexes) {
    let moved = false;
    const files = entry.files.map((file) => {
      if (!isUnder(key, fold(file.source))) return file;
      moved = true;
      const rest = path.resolve(file.source).slice(prefixLength);
      return { deployed: file.deployed, source: target + rest };
    });
    if (moved) {
      entry.files = files;
      touched.push(owner);
    }
  }
  if (touched.length > 0) changed(touched);
}

/** The staged file behind `filePath`, if a virtual deployment serves it. */
export function virtualSource(filePath: string): string | undefined {
  return index.files.get(fold(filePath));
}

function virtualChildren(dirPath: string): Map<string, IDirEntry> | undefined {
  return index.dirs.get(fold(dirPath));
}

export interface IVirtualEntry {
  /** Where programs see it. */
  filePath: string;
  isDirectory: boolean;
  /** The staged file, for a file. */
  source?: string;
}

/**
 * Everything a virtual deployment adds below `dirPath` (its direct children only unless
 * `recurse`): files with their staged sources, and the folders on their paths. A walk that
 * starts above a deployment's root reaches the root's entries too.
 */
export function virtualEntriesUnder(dirPath: string, recurse: boolean): IVirtualEntry[] {
  const out: IVirtualEntry[] = [];
  const visit = (dir: string, depthLeft: boolean) => {
    for (const child of virtualChildren(dir)?.values() ?? []) {
      const filePath = path.join(dir, child.name);
      if (child.isDir) {
        out.push({ filePath, isDirectory: true });
        if (depthLeft) {
          visit(filePath, depthLeft);
        }
      } else {
        out.push({ filePath, isDirectory: false, source: virtualSource(filePath) });
      }
    }
  };
  const start = path.resolve(dirPath);
  if (virtualChildren(start) !== undefined) {
    visit(start, recurse);
  } else if (recurse) {
    const folded = fold(start);
    for (const [rootKey, root] of index.roots) {
      if (rootKey !== folded && isUnder(folded, rootKey)) {
        visit(root, true);
      }
    }
  }
  return out;
}

type AnyFn = (...args: any[]) => any;

/** The unwrapped functions, for code that must see the real disk. */
export const realFs = { promises: {} } as unknown as Record<string, AnyFn | undefined> & {
  promises: Record<string, AnyFn | undefined>;
};

function nodeFs(): typeof fsType {
  // The module itself, to wrap in place: an import is a namespace copy of it. Tests, which run
  // without webpack, only read through it.
  return typeof __non_webpack_require__ === "function"
    ? (__non_webpack_require__("fs") as typeof fsType)
    : fsModule;
}

/** `[mapped path, directory anchor]` for a path argument. */
function redirect(input: unknown): { target: unknown; dirAnchor?: string } {
  if (typeof input !== "string") {
    return { target: input };
  }
  if (index.hidden.has(fold(input))) {
    // Deleted by a program: answered as a path that does not exist (the folder it would be
    // in is never created), so every read fails as a missing file does.
    return { target: path.join(path.dirname(input), HIDDEN_FOLDER, path.basename(input)) };
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
    const name = typeof entry === "string" ? entry : entry.name;
    if (!index.hidden.has(fold(path.join(dirPath, name)))) {
      out.set(foldName(name), entry);
    }
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

const wrapped = new WeakSet<object>();

/**
 * Wrap `fs` and `fs/promises`, and Electron's `original-fs`: graceful-fs and rimraf are handed
 * that one (`requireRemap`), so fs-extra and Vortex's `util/fs` read through it. Idempotent per
 * module; `realFs` keeps the first module's originals.
 */
export function install(fs: typeof fsType = nodeFs()): void {
  if (wrapped.has(fs)) {
    return;
  }
  wrapped.add(fs);
  // A `promises` object two modules share is wrapped once; the second pass wraps a copy.
  const promises = (wrapped.has(fs.promises)
    ? { ...fs.promises }
    : fs.promises) as unknown as Record<string, AnyFn>;
  wrapped.add(fs.promises);
  const sync = fs as unknown as Record<string, AnyFn>;

  const wrapPath = (name: string, onDirAnchor: boolean) => {
    const original = sync[name];
    if (typeof original !== "function") return;
    realFs[name] ??= original;
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
    realFs.promises[name] ??= original;
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
  // Copying a deployed file copies its staged file.
  for (const name of ["readFile", "readFileSync", "createReadStream", "copyFile", "copyFileSync"]) {
    wrapPath(name, false);
  }
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
  for (const name of ["readFile", "copyFile"]) wrapPromisePath(name, false);
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
  realFs.readdir ??= readdir;
  realFs.readdirSync ??= readdirSync;
  realFs.promises.readdir ??= readdirPromise;
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

  wrapRenames(fs, sync, promises);
  wrapDeletes(fs, sync, promises);
  wrapRealpaths(fs, sync, promises);
}

/** A deployed file, or a folder only mods provide, is its own real path. */
function wrapRealpaths(
  fs: typeof fsType,
  sync: Record<string, AnyFn>,
  promises: Record<string, AnyFn>,
) {
  const isVirtualPath = (input: unknown): input is string =>
    isVirtualFile(input) ||
    (typeof input === "string" && virtualChildren(input) !== undefined && !realExists(fs, input));
  const realpath = sync.realpath;
  const realpathSync = sync.realpathSync;
  const realpathPromise = promises.realpath;
  realFs.realpath ??= realpath;
  realFs.realpathSync ??= realpathSync;
  realFs.promises.realpath ??= realpathPromise;
  // Object.assign keeps `.native`, which callers use as well.
  sync.realpathSync = Object.assign(function (this: unknown, input: unknown, ...rest: unknown[]) {
    return isVirtualPath(input) ? path.resolve(input) : realpathSync.call(this, input, ...rest);
  }, realpathSync);
  sync.realpath = Object.assign(function (this: unknown, input: unknown, ...rest: unknown[]) {
    if (!isVirtualPath(input)) return realpath.call(this, input, ...rest);
    const callback = rest[rest.length - 1];
    if (typeof callback === "function")
      process.nextTick(callback as AnyFn, null, path.resolve(input));
    return undefined;
  }, realpath);
  promises.realpath = async function (this: unknown, input: unknown, ...rest: unknown[]) {
    return isVirtualPath(input) ? path.resolve(input) : realpathPromise.call(this, input, ...rest);
  };
}

/** `install` on `fs` and, under Electron, on `original-fs`. */
export function installAll(): void {
  install();
  if (typeof __non_webpack_require__ === "function" && process.versions.electron !== undefined) {
    install(__non_webpack_require__("original-fs") as typeof fsType);
  }
}

const isVirtualFile = (input: unknown): input is string =>
  typeof input === "string" && virtualSource(input) !== undefined;
const holdsVirtual = (input: unknown): input is string =>
  isVirtualFile(input) || (typeof input === "string" && virtualChildren(input) !== undefined);

/** Settle a callback-style call the way Node does: asynchronously. */
function settle(callback: unknown, run: () => void) {
  let error: unknown = null;
  try {
    run();
  } catch (err) {
    error = err;
  }
  if (typeof callback === "function") process.nextTick(callback as AnyFn, error);
}

/**
 * Renames behave as they did with hard links: renaming a deployed file moves it within the
 * view (Vortex's plugin ghosting renames `X.esp` to `X.esp.ghost` this way) and its staged file
 * stays; renaming a staged file or folder keeps what it serves deployed.
 */
function wrapRenames(
  fs: typeof fsType,
  sync: Record<string, AnyFn>,
  promises: Record<string, AnyFn>,
) {
  const rename = sync.rename;
  const renameSync = sync.renameSync;
  const renamePromise = promises.rename;
  realFs.rename ??= rename;
  realFs.renameSync ??= renameSync;
  realFs.promises.rename ??= renamePromise;
  const followSources = (from: unknown, to: unknown) => {
    if (typeof from === "string" && typeof to === "string") moveSources(from, to);
  };
  sync.renameSync = function (this: unknown, from: unknown, to: unknown) {
    if (isVirtualFile(from) && typeof to === "string") {
      moveVirtual(from, to, fs);
      return undefined;
    }
    const result = renameSync.call(this, from, to);
    followSources(from, to);
    return result;
  };
  sync.rename = function (this: unknown, from: unknown, to: unknown, callback: unknown) {
    if (isVirtualFile(from) && typeof to === "string") {
      return settle(callback, () => moveVirtual(from, to, fs));
    }
    return rename.call(this, from, to, (err: NodeJS.ErrnoException | null) => {
      if (!err) followSources(from, to);
      if (typeof callback === "function") callback(err);
    });
  };
  promises.rename = async function (this: unknown, from: unknown, to: unknown) {
    if (isVirtualFile(from) && typeof to === "string") {
      moveVirtual(from, to, fs);
      return;
    }
    await renamePromise.call(this, from, to);
    followSources(from, to);
  };
}

/**
 * Deleting a deployed file, or a folder holding deployed files, removes them from the view as
 * deleting hard links did; the staged files stay. Real files there are deleted as before.
 */
function wrapDeletes(
  fs: typeof fsType,
  sync: Record<string, AnyFn>,
  promises: Record<string, AnyFn>,
) {
  for (const name of ["unlink", "rm"] as const) {
    const callbackFn = sync[name];
    const syncFn = sync[`${name}Sync`];
    const promiseFn = promises[name];
    realFs[name] ??= callbackFn;
    realFs[`${name}Sync`] ??= syncFn;
    realFs.promises[name] ??= promiseFn;
    const applies = name === "unlink" ? isVirtualFile : holdsVirtual;
    // A deployed file over a game original hides it, as the link that replaced it did: only
    // the deployed file goes. A folder is deleted on disk as well, real files included.
    const alsoReal = (target: string) => !isVirtualFile(target) && realExists(fs, target);
    // A file a program deleted is gone, as it was in the game folder; the game's original
    // under the deletion stays untouched. `rm` with `force` succeeds on a missing file.
    const gone = (target: unknown, rest: unknown[]): NodeJS.ErrnoException | null | undefined => {
      if (typeof target !== "string" || !isHidden(target)) return undefined;
      const options = rest[0];
      if (name === "rm" && typeof options === "object" && (options as { force?: boolean })?.force) {
        return null;
      }
      return Object.assign(new Error(`ENOENT: no such file or directory, ${name} '${target}'`), {
        code: "ENOENT",
        errno: -4058,
        syscall: name,
        path: target,
      });
    };
    sync[`${name}Sync`] = function (this: unknown, target: unknown, ...rest: unknown[]) {
      const missing = gone(target, rest);
      if (missing) throw missing;
      if (missing === null) return undefined;
      if (!applies(target)) return syncFn.call(this, target, ...rest);
      const real = alsoReal(target);
      removeVirtual(target);
      if (real) syncFn.call(this, target, ...rest);
      return undefined;
    };
    sync[name] = function (this: unknown, target: unknown, ...rest: unknown[]) {
      const callback = rest[rest.length - 1];
      const missing = gone(target, rest);
      if (missing !== undefined) {
        return settle(callback, () => {
          if (missing) throw missing;
        });
      }
      if (!applies(target)) return callbackFn.call(this, target, ...rest);
      const real = alsoReal(target);
      removeVirtual(target);
      if (real) return callbackFn.call(this, target, ...rest);
      return settle(callback, () => undefined);
    };
    promises[name] = async function (this: unknown, target: unknown, ...rest: unknown[]) {
      const missing = gone(target, rest);
      if (missing) throw missing;
      if (missing === null) return undefined;
      if (!applies(target)) return promiseFn.call(this, target, ...rest);
      const real = alsoReal(target);
      removeVirtual(target);
      if (real) await promiseFn.call(this, target, ...rest);
      return undefined;
    };
  }
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
