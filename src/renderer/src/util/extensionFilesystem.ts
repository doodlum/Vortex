import type * as nodeFs from "node:fs";

import { resolveNativePath } from "./casePath";

const TWO_PATH_OPERATIONS = new Set([
  "copy",
  "copyAsync",
  "copyFile",
  "copyFileSync",
  "link",
  "linkAsync",
  "linkSync",
  "move",
  "moveAsync",
  "moveRenameAsync",
  "rename",
  "renameAsync",
  "renameSync",
  "symlink",
  "symlinkAsync",
  "symlinkSync",
]);

const PATH_OPERATIONS =
  /^(?:access|appendFile|chmod|chown|copy|createReadStream|createWriteStream|ensureDir|ensureDirWritable|ensureFile|exists|isDirectory|link|lstat|makeFileWritable|mkdir|move|open|readFile|readdir|readlink|realpath|remove|rename|rmdir|stat|truncate|unlink|utimes|watch|writeFile)/;

/**
 * Present extension filesystem calls with Windows-style path lookup on Linux.
 *
 * Community extensions are predominantly authored and tested on case-insensitive filesystems.
 * Resolving at the API/module boundary keeps that platform detail out of every extension and also
 * prevents differently-cased writes from creating a second directory tree.
 */
export function extensionFilesystem<T extends object>(filesystem: T): T {
  if (process.platform === "win32") {
    return filesystem;
  }

  return new Proxy(filesystem, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (
        typeof property !== "string" ||
        typeof value !== "function" ||
        !PATH_OPERATIONS.test(property)
      ) {
        return value;
      }

      return (...args: unknown[]) => {
        const pathCount = TWO_PATH_OPERATIONS.has(property) ? 2 : 1;
        for (let index = 0; index < pathCount; index += 1) {
          if (typeof args[index] === "string") {
            args[index] = resolveNativePath(args[index] as string);
          }
        }
        return Reflect.apply(value, target, args);
      };
    },
  });
}

export type ExtensionNodeFilesystem = typeof nodeFs;
