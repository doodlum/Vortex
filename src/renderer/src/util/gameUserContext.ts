import { AsyncResource, createHook, executionAsyncResource } from "node:async_hooks";
import * as path from "node:path";
import { URL as NodeURL, fileURLToPath, pathToFileURL } from "node:url";

import { VortexGameId } from "@vortex/shared";
import Bluebird from "bluebird";

import type { IDiscoveryResult } from "../extensions/gamemode_management/types/IDiscoveryResult";
import {
  getGameDefinition as getGame,
  getGameDiscovery,
  getRegisteredGameDefinitions,
} from "../extensions/gamemode_management/util/gameRegistry";
import { nativeRelPath, resolveCasePath } from "./casePath";
import {
  getGameWinePrefix,
  getHostGameUserPath,
  resolveProtonUserPath,
  resolveProtonWindowsPath,
  type GameUserPath,
} from "./getGameUserPath";
import getVortexPath from "./getVortexPath";
import { isResolvingGameExecutable, isWindowsGame } from "./isWindowsGame";

export interface GameUserContext {
  gameId: VortexGameId;
  discovery: IDiscoveryResult | undefined;
}

/**
 * AsyncLocalStorage's async_hooks implementation. Node 24's default AsyncLocalStorage reads V8's
 * continuation-preserved embedder data, which Blink also sets while an Electron renderer handles
 * user input; a synchronous getStore() from a click handler then aborts V8 ("null prototype chain
 * root"). Execution resources are Node's own, so they stay valid in Blink tasks.
 */
class ResourceContext<T> {
  private readonly key = Symbol("vortex.gameUserContext");
  private readonly hook = createHook({
    init: (_asyncId, _type, _triggerAsyncId, resource) => {
      const current = executionAsyncResource() as Record<symbol, unknown> | undefined;
      if (current !== undefined && current !== null && this.key in current)
        (resource as Record<symbol, unknown>)[this.key] = current[this.key];
    },
  });
  private enabled = false;

  public run<R>(store: T, callback: () => R): R {
    if (!this.enabled) {
      this.hook.enable();
      this.enabled = true;
    }
    return new AsyncResource("VortexGameUserContext").runInAsyncScope(() => {
      (executionAsyncResource() as Record<symbol, unknown>)[this.key] = store;
      return callback();
    });
  }

  public getStore(): T | undefined {
    const current = executionAsyncResource() as Record<symbol, unknown> | undefined;
    return (current?.[this.key] as T | undefined) ?? undefined;
  }
}

const context = new ResourceContext<GameUserContext>();
let bluebirdContextEnabled = false;
const windowsIdentities = new WeakMap<GameUserContext, boolean>();
const classifyingGames = new Set<VortexGameId>();

function windowsOwner(owner: GameUserContext): boolean {
  const known = windowsIdentities.get(owner);
  if (known !== undefined) return known;
  // Executable selectors may themselves read the filesystem to identify the build.
  if (classifyingGames.has(owner.gameId)) return false;
  classifyingGames.add(owner.gameId);
  try {
    const result = isWindowsGame(getGame(owner.gameId), owner.discovery);
    windowsIdentities.set(owner, result);
    return result;
  } finally {
    classifyingGames.delete(owner.gameId);
  }
}

/** Scope a game callback without changing Vortex's own host path API. */
export function withGameUserPaths<T>(
  gameId: VortexGameId,
  discovery: IDiscoveryResult | undefined,
  callback: () => T,
): T {
  if (process.platform !== "linux") return callback();
  if (!bluebirdContextEnabled) {
    // Shared/resolved Bluebird promises otherwise inherit the scheduler's context.
    const options: Parameters<typeof Bluebird.config>[0] & { asyncHooks: boolean } = {
      asyncHooks: true,
    };
    Bluebird.config(options);
    bluebirdContextEnabled = true;
  }
  return context.run(
    { gameId, discovery: discovery === undefined ? undefined : { ...discovery } },
    callback,
  );
}

export function currentGameUserContext(): GameUserContext | undefined {
  // Contexts only exist on Linux; elsewhere filesystem calls keep upstream's cost and behaviour.
  if (process.platform !== "linux") return undefined;
  return context.getStore();
}

/** A single-game extension can resolve later event/UI I/O without an active-game guess. */
export function extensionGameUserContext(extensionPath: string): () => GameUserContext | undefined {
  return () => {
    const active = currentGameUserContext();
    if (active !== undefined) return active;
    const games = getRegisteredGameDefinitions().filter(
      (game) =>
        game.extensionPath !== undefined &&
        relativeInside(extensionPath, game.extensionPath) !== undefined,
    );
    if (games.length !== 1) return undefined;
    return { gameId: VortexGameId(games[0].id), discovery: getGameDiscovery(games[0].id) };
  };
}

const userRoots: GameUserPath[] = ["localLowAppData", "localAppData", "appData", "documents"];
const hostRoots = [
  "userData",
  "base",
  "assets",
  "modules",
  "bundledPlugins",
  "application",
  "package",
  "locales",
] as const;

function relativeInside(root: string | undefined, filePath: string): string | undefined {
  if (typeof root !== "string" || !path.isAbsolute(root)) return undefined;
  const relative = path.relative(root, filePath);
  return relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)
    ? undefined
    : relative;
}

/** Translate legacy game-owned path results/arguments, including module-cached host roots. */
export function resolveLegacyGamePath(filePath: string, owner = currentGameUserContext()): string {
  if (
    typeof filePath !== "string" ||
    process.platform !== "linux" ||
    owner === undefined ||
    isResolvingGameExecutable() ||
    !windowsOwner(owner)
  )
    return filePath;
  if (!path.isAbsolute(filePath) && /^[a-z]:[\\/]/i.test(filePath))
    return resolveProtonWindowsPath(getGameWinePrefix(owner.discovery), filePath);
  const normalized = path.normalize(nativeRelPath(filePath));
  if (!path.isAbsolute(normalized)) return filePath;
  const gameRelative = relativeInside(owner.discovery?.path, normalized);
  if (gameRelative !== undefined && owner.discovery?.path !== undefined)
    return resolveCasePath(owner.discovery.path, gameRelative);
  // Host caches/resources are not the Windows game's user data, even below AppData.
  if (hostRoots.some((name) => relativeInside(getVortexPath(name), normalized) !== undefined))
    return filePath;
  const roots = userRoots
    .map((name) => ({ name, root: getHostGameUserPath(name) }))
    .sort((a, b) => b.root.length - a.root.length);
  for (const { name, root } of roots) {
    const relative = relativeInside(root, normalized);
    if (relative !== undefined) {
      const prefix = getGameWinePrefix(owner.discovery);
      // A Steam library (and its prefix) can itself live below host Documents.
      const existing = relativeInside(prefix, normalized);
      return existing === undefined
        ? resolveProtonUserPath(prefix, name, relative)
        : resolveCasePath(prefix, existing);
    }
  }
  return filePath;
}

// Only filesystem path positions are translated; payloads, options and fd arguments retain their values.
const firstPath = new Set([
  "access",
  "appendFile",
  "chmod",
  "chown",
  "exists",
  "existsSync",
  "lchmod",
  "lchown",
  "lstat",
  "lstatSync",
  "lutimes",
  "mkdir",
  "mkdtemp",
  "open",
  "opendir",
  "opendirSync",
  "readdir",
  "readFile",
  "readlink",
  "readlinkSync",
  "realpath",
  "realpathSync",
  "rm",
  "rmSync",
  "rmdir",
  "stat",
  "statfs",
  "statfsSync",
  "truncate",
  "truncateSync",
  "unlink",
  "unlinkSync",
  "utimes",
  "writeFile",
  "ensureDir",
  "ensureFile",
  "emptyDir",
  "emptyDirSync",
  "mkdirp",
  "mkdirs",
  "outputFile",
  "outputFileSync",
  "outputJson",
  "outputJsonSync",
  "outputJSON",
  "outputJSONSync",
  "pathExists",
  "pathExistsSync",
  "readJson",
  "readJsonSync",
  "readJSON",
  "readJSONSync",
  "remove",
  "writeJson",
  "writeJsonSync",
  "writeJSON",
  "writeJSONSync",
  "ReadStream",
  "WriteStream",

  "chmodSync",
  "chownSync",
  "lchmodSync",
  "lchownSync",
  "lutimesSync",
  "mkdirSync",
  "mkdtempSync",
  "rmdirSync",
  "utimesSync",
  "watchFile",
  "unwatchFile",
  "accessSync",
  "appendFileSync",
  "createReadStream",
  "createWriteStream",
  "openSync",
  "readdirSync",
  "readFileSync",
  "statSync",
  "writeFileSync",
  "watch",
  "appendFileAsync",
  "chmodAsync",
  "lstatAsync",
  "mkdirAsync",
  "mkdirsAsync",
  "openAsync",
  "readdirAsync",
  "readFileAsync",
  "statAsync",
  "statSilentAsync",
  "utimesAsync",
  "writeFileAsync",
  "isDirectoryAsync",
  "ensureDirSync",
  "ensureFileAsync",
  "ensureDirAsync",
  "removeSync",
  "unlinkAsync",
  "rmdirAsync",
  "removeAsync",
  "readlinkAsync",
  "ensureDirWritableAsync",
  "changeFileOwnership",
  "changeFileAttributes",
  "makeFileWritableAsync",
  "readFileBOM",
]);
const twoPaths = new Set([
  "copy",
  "copySync",
  "copyFile",
  "copyFileSync",
  "cp",
  "cpSync",
  "link",
  "rename",
  "renameSync",
  "symlink",
  "move",
  "moveSync",
  "ensureLink",
  "ensureLinkSync",
  "ensureSymlink",
  "ensureSymlinkSync",
  "linkSync",
  "symlinkSync",
  "moveAsync",
  "symlinkAsync",
  "moveRenameAsync",
  "copyAsync",
  "linkAsync",
  "renameAsync",
]);

function filesystemPath(value: string, owner: GameUserContext | undefined): string {
  const resolved = resolveLegacyGamePath(value, owner);
  return resolved !== value && /[\\/]$/.test(value) && !resolved.endsWith(path.sep)
    ? resolved + path.sep
    : resolved;
}

function pathArgument(value: unknown, owner: GameUserContext | undefined): unknown {
  if (typeof value === "string") return filesystemPath(value, owner);
  if ((value instanceof NodeURL || value instanceof URL) && value.protocol === "file:") {
    const before = fileURLToPath(new NodeURL(String(value)));
    const after = filesystemPath(before, owner);
    return before === after ? value : pathToFileURL(after);
  }
  if (Buffer.isBuffer(value)) {
    const text = value.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(value)) return value;
    const after = filesystemPath(text, owner);
    return after === text ? value : Buffer.from(after, "utf8");
  }
  return value;
}

type ContextGetter = () => GameUserContext | undefined;
const namespaceCache = new WeakMap<object, WeakMap<ContextGetter, Map<string, object>>>();

/** Per-extension namespace adapter. Internal Vortex imports keep the original filesystem. */
export function gameUserPathNamespace<T extends object>(
  namespace: "fs" | "util",
  target: T,
  getContext: ContextGetter = currentGameUserContext,
): T {
  if (process.platform !== "linux") return target;
  let contexts = namespaceCache.get(target);
  if (contexts === undefined) {
    contexts = new WeakMap();
    namespaceCache.set(target, contexts);
  }
  let namespaces = contexts.get(getContext);
  if (namespaces === undefined) {
    namespaces = new Map();
    contexts.set(getContext, namespaces);
  }
  const cached = namespaces.get(namespace);
  if (cached !== undefined) return cached as T;
  type Callable = (...args: unknown[]) => unknown;
  const methods = new Map<PropertyKey, { original: Callable; wrapped: Callable }>();
  const read = (key: PropertyKey): unknown => {
    const original = Reflect.get(target, key);
    if (
      namespace === "fs" &&
      key === "promises" &&
      original !== null &&
      typeof original === "object"
    )
      return gameUserPathNamespace("fs", original, getContext);
    const count =
      typeof key !== "string"
        ? 0
        : namespace === "fs"
          ? twoPaths.has(key)
            ? 2
            : firstPath.has(key)
              ? 1
              : 0
          : key === "opn"
            ? 1
            : 0;
    if (count === 0 || typeof original !== "function") return original;
    const existing = methods.get(key);
    if (existing?.original === original) return existing.wrapped;
    const mappedArgs = (input: unknown[]) => {
      const owner = getContext();
      if (owner === undefined || process.platform !== "linux") return input;
      const args = [...input];
      const streamOptions = input[1];
      if (
        namespace === "fs" &&
        ["ReadStream", "WriteStream", "createReadStream", "createWriteStream"].includes(
          String(key),
        ) &&
        streamOptions !== null &&
        typeof streamOptions === "object" &&
        "fd" in streamOptions &&
        streamOptions.fd !== undefined &&
        streamOptions.fd !== null
      )
        return input;
      for (let index = 0; index < Math.min(count, args.length); index++) {
        if (
          namespace === "util" &&
          typeof args[index] === "string" &&
          /^file:/i.test(args[index] as string)
        ) {
          const before = new NodeURL(args[index] as string);
          const mapped = pathArgument(before, owner);
          args[index] = mapped === before ? input[index] : (mapped as NodeURL).href;
        } else args[index] = pathArgument(args[index], owner);
      }
      return args;
    };
    const callable = original as Callable;
    let native: { original: Callable; wrapped: Callable } | undefined;
    const adapt = (func: Callable): Callable =>
      new Proxy(func, {
        apply: (inner, receiver, args) => Reflect.apply(inner, receiver, mappedArgs(args)),
        construct: (inner, args, newTarget) =>
          Reflect.construct(inner, mappedArgs(args), newTarget),
        get: (inner, prop, receiver) => {
          const member = Reflect.get(inner, prop, receiver);
          const descriptor = Reflect.getOwnPropertyDescriptor(inner, prop);
          if (
            prop === "native" &&
            typeof member === "function" &&
            (descriptor?.configurable !== false || descriptor?.writable !== false)
          ) {
            if (native?.original === member) return native.wrapped;
            native = { original: member as Callable, wrapped: adapt(member as Callable) };
            return native.wrapped;
          }
          return member;
        },
      });
    const wrapped = adapt(callable);
    methods.set(key, { original: callable, wrapped });
    return wrapped;
  };
  // A facade also permits wrapping frozen ESM exports. Descriptor-based fs clones must
  // receive the same adapted functions as ordinary property reads.
  const facade = Object.create(Object.getPrototypeOf(target));
  const adaptedDescriptor = (key: PropertyKey): PropertyDescriptor | undefined => {
    const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
    if (descriptor === undefined) return undefined;
    if ("value" in descriptor) return { ...descriptor, value: read(key), configurable: true };
    return {
      ...descriptor,
      get: descriptor.get === undefined ? undefined : () => read(key),
      set:
        descriptor.set === undefined
          ? undefined
          : (value) => Reflect.set(target, key, value, target),
      configurable: true,
    };
  };
  const syncFixedDescriptor = (key: PropertyKey) => {
    const fixed = Reflect.getOwnPropertyDescriptor(facade, key);
    if (fixed?.configurable === false && fixed.writable === true)
      Reflect.defineProperty(facade, key, { value: read(key) });
  };
  const wrapped = new Proxy(facade, {
    get: (_facade, key) => {
      const fixed = Reflect.getOwnPropertyDescriptor(facade, key);
      return fixed?.configurable === false && "value" in fixed && !fixed.writable
        ? fixed.value
        : read(key);
    },
    has: (_facade, key) => Reflect.has(target, key),
    ownKeys: () => Reflect.ownKeys(target),
    getOwnPropertyDescriptor: (_facade, key) => {
      syncFixedDescriptor(key);
      return Reflect.getOwnPropertyDescriptor(facade, key) ?? adaptedDescriptor(key);
    },
    set: (_facade, key, value) => {
      const result = Reflect.set(target, key, value, target);
      if (result) syncFixedDescriptor(key);
      return result;
    },
    defineProperty: (_facade, key, descriptor) => {
      if (!Reflect.defineProperty(target, key, descriptor)) return false;
      const actual = Reflect.getOwnPropertyDescriptor(target, key);
      if (actual?.configurable === false) {
        const reflected = adaptedDescriptor(key);
        // An explicitly locked replacement must retain the exact value requested by
        // its owner. Other exports (including frozen original namespaces) stay adapted.
        if (!("value" in actual) || ("value" in descriptor && actual.writable === false))
          Reflect.defineProperty(facade, key, { ...actual });
        else Reflect.defineProperty(facade, key, { ...reflected, configurable: false });
      }
      return true;
    },
    deleteProperty: (_facade, key) =>
      Reflect.deleteProperty(target, key) && Reflect.deleteProperty(facade, key),
    // Freezing only the facade would let its keys diverge from the original module.
    preventExtensions: () => false,
  }) as T;
  namespaces.set(namespace, wrapped);
  return wrapped;
}
