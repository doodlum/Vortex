import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { resolveNativePath } from "../casePath";

const LOOT_PIPE_PREFIX = "\\\\?\\pipe\\loot-ipc-";

type LootModule = {
  LootAsync: {
    create: (...args: unknown[]) => void;
  };
  [key: string]: unknown;
};

type LootNativeModule = {
  Loot: new (...args: any[]) => object;
  [key: string]: unknown;
};

let cachedSource: LootModule | undefined;
let cachedModule: LootModule | undefined;

export function isLootWorker(modulePath: unknown): modulePath is string {
  return (
    process.platform === "linux" &&
    typeof modulePath === "string" &&
    path.basename(modulePath) === "async.js" &&
    modulePath.toLowerCase().includes("gamebryo-plugin-management")
  );
}

export function lootWorkerDirectory(): string {
  return os.tmpdir();
}

function actualPluginName(gamePath: string, requested: unknown): unknown {
  if (typeof requested !== "string") return requested;
  const dataPath = resolveNativePath(path.join(gamePath, "Data"));
  try {
    const requestedKey = requested.replace(/\.ghost$/i, "").toLowerCase();
    const entry = fs.readdirSync(dataPath).find((name) => name.toLowerCase() === requestedKey);
    return entry ?? requested;
  } catch {
    return requested;
  }
}

function wrapInstance(instance: object, gamePath: string): object {
  const pluginArrayMethods = new Set(["loadPlugins", "sortPlugins"]);
  const pluginMethods = new Set(["getPlugin", "getPluginMetadata"]);
  const listMethods = new Set(["loadLists"]);

  return new Proxy(instance, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof property !== "string" || typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (pluginArrayMethods.has(property) && Array.isArray(args[0])) {
          args[0] = args[0].map((name) => actualPluginName(gamePath, name));
        } else if (pluginMethods.has(property)) {
          args[0] = actualPluginName(gamePath, args[0]);
        } else if (listMethods.has(property)) {
          args = args.map((arg) => (typeof arg === "string" ? resolveNativePath(arg) : arg));
        }
        return Reflect.apply(value, target, args);
      };
    },
  });
}

function withLinuxPipe<T>(callback: () => T): T {
  const originalListen = net.Server.prototype.listen;
  net.Server.prototype.listen = function (...args: any[]) {
    if (typeof args[0] === "string" && args[0].startsWith(LOOT_PIPE_PREFIX)) {
      args[0] = path.join(os.tmpdir(), args[0]);
    }
    return originalListen.apply(this, args as any);
  } as typeof net.Server.prototype.listen;
  try {
    return callback();
  } finally {
    net.Server.prototype.listen = originalListen;
  }
}

/** Adapt the native binding loaded by the stock bundled extension. */
export function linuxLootNativeModule(source: LootNativeModule): LootNativeModule {
  if (process.platform !== "linux") return source;
  const Loot = new Proxy(source.Loot, {
    construct(target, args, newTarget) {
      const gamePath = resolveNativePath(args[1] as string);
      args[1] = gamePath;
      args[2] = resolveNativePath(args[2] as string);
      return wrapInstance(Reflect.construct(target, args, newTarget), gamePath);
    },
  });
  return { ...source, Loot };
}

/** Give bundled Windows-oriented IPC clients an absolute Unix socket endpoint. */
export function extensionNetwork(source: typeof net): typeof net {
  if (process.platform !== "linux") return source;
  const Server = class extends source.Server {
    public listen(...args: any[]): this {
      if (typeof args[0] === "string" && args[0].startsWith(LOOT_PIPE_PREFIX)) {
        args[0] = path.join(os.tmpdir(), args[0]);
      }
      return super.listen(...(args as [any]));
    }
  };
  return new Proxy(source, {
    get(target, property, receiver) {
      return property === "Server" ? Server : Reflect.get(target, property, receiver);
    },
  });
}

/** Use the stock node-loot API unchanged, adapting only its platform boundary. */
export function linuxLootModule(source: LootModule): LootModule {
  if (process.platform !== "linux") return source;
  if (cachedSource === source && cachedModule !== undefined) return cachedModule;

  const stockCreate = source.LootAsync.create.bind(source.LootAsync);
  const LootAsync = new Proxy(source.LootAsync, {
    get(target, property, receiver) {
      if (property !== "create") return Reflect.get(target, property, receiver);
      return (...args: unknown[]) => {
        const gamePath = resolveNativePath(args[1] as string);
        const callbackIndex = args.length - 1;
        const callback = args[callbackIndex] as (error: unknown, instance?: object) => void;
        args[1] = gamePath;
        args[2] = resolveNativePath(args[2] as string);
        args[callbackIndex] = (error: unknown, instance?: object) =>
          callback(error, instance === undefined ? undefined : wrapInstance(instance, gamePath));
        return withLinuxPipe(() => stockCreate(...args));
      };
    },
  });

  cachedSource = source;
  cachedModule = { ...source, LootAsync };
  return cachedModule;
}
