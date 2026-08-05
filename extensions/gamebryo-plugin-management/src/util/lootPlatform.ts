import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

const LOOT_PIPE_PREFIX = "\\\\?\\pipe\\loot-ipc-";

function resolveExistingPath(input: string): string {
  if (process.platform !== "linux" || typeof input !== "string" || fs.existsSync(input)) {
    return input;
  }
  const parsed = path.parse(path.resolve(input));
  let current = parsed.root;
  for (const part of path.resolve(input).slice(parsed.root.length).split(path.sep)) {
    try {
      const actual = fs
        .readdirSync(current)
        .find((entry) => entry.toLowerCase() === part.toLowerCase());
      current = path.join(current, actual ?? part);
    } catch {
      current = path.join(current, part);
    }
  }
  return current;
}

function withLinuxPipe<T>(callback: () => T): T {
  if (process.platform !== "linux") return callback();
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

/** Platform boundary for the official LOOT extension. */
export function platformLootAsync<T extends { create: (...args: any[]) => any }>(source: T): T {
  if (process.platform !== "linux") return source;
  const create = source.create.bind(source);
  return new Proxy(source, {
    get(target, property, receiver) {
      if (property !== "create") return Reflect.get(target, property, receiver);
      return (...args: any[]) => {
        args[1] = resolveExistingPath(args[1]);
        args[2] = resolveExistingPath(args[2]);
        return withLinuxPipe(() => create(...args));
      };
    },
  });
}

export function lootWorkerDirectory(): string | undefined {
  return process.platform === "linux" ? os.tmpdir() : undefined;
}
