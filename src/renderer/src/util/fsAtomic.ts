import { createHash } from "crypto";
import { close as closeFileDescriptor } from "node:fs";
import { copyFile, rename, unlink } from "node:fs/promises";

import { getErrorCode, unknownToError } from "@vortex/shared";
import PromiseBB from "bluebird";
import { file } from "tmp";

import { checksum } from "./checksum";
import * as fs from "./fs";
import { log } from "./log";

export function writeFileAtomic(filePath: string, input: string | Buffer) {
  return writeFileAtomicImpl(filePath, input, 3);
}

function writeFileAtomicImpl(
  filePath: string,
  input: string | Buffer,
  attempts: number,
): PromiseBB<void> {
  const stackErr = new Error();
  let cleanup: ((next?: (err?: Error) => void) => void) | undefined;
  let tmpPath: string;
  const buf: Buffer = input instanceof Buffer ? input : Buffer.from(input);

  const callCleanup = (): PromiseBB<void> => {
    const remove = cleanup;
    cleanup = undefined;
    if (remove === undefined) return PromiseBB.resolve();
    return new PromiseBB<void>((resolve) => {
      try {
        remove((err) => {
          if (err) log("error", "failed to clean up temporary file", err);
          resolve();
        });
      } catch (err) {
        log("error", "failed to clean up temporary file", err);
        resolve();
      }
    });
  };

  const hash = checksum(buf);
  let fd = -1;
  const closeDescriptor = (): PromiseBB<void> => {
    const ownedFd = fd;
    fd = -1;
    if (ownedFd === -1) return PromiseBB.resolve();
    return new PromiseBB<void>((resolve) => {
      try {
        // Close our descriptor once. Retrying close could affect a recycled descriptor.
        closeFileDescriptor(ownedFd, (err) => {
          if (err) log("warn", "failed to close temporary file", err);
          resolve();
        });
      } catch (err) {
        log("warn", "failed to close temporary file", err);
        resolve();
      }
    });
  };
  const createTemporaryFile = fs.genFSWrapperAsync(
    () =>
      new PromiseBB<void>((resolve, reject) => {
        // We own the descriptor; tmp owns only pathname cleanup and its registry entry.
        file(
          { template: `${filePath}.XXXXXX.tmp`, detachDescriptor: true },
          (err, name, fdIn, cleanupCB) => {
            if (err) return reject(err);
            fd = fdIn;
            tmpPath = name;
            cleanup = cleanupCB;
            resolve();
          },
        );
      }),
  );
  return createTemporaryFile()
    .then(() =>
      fs
        .writeAsync(fd, buf, 0, buf.byteLength, 0)
        .then(() => fs.fsyncAsync(fd).catch(() => PromiseBB.resolve()))
        .finally(closeDescriptor),
    )
    .then(() => fs.readFileAsync(tmpPath))
    .catch({ code: "EBADF" }, () => {
      log("warn", "failed to access temporary file", {
        filePath,
        fd,
      });
      return PromiseBB.resolve(undefined);
    })
    .then((data) => {
      if (data === undefined || checksum(data) !== hash) {
        return callCleanup().then(() =>
          attempts > 0
            ? // retry
              writeFileAtomicImpl(filePath, input, attempts - 1)
            : PromiseBB.reject(new Error("Write failed, checksums differ")),
        );
      } else {
        return fs.renameAsync(tmpPath, filePath).catch({ code: "EEXIST" }, () =>
          // renameAsync is supposed to overwrite so this is likely to fail as well
          fs.removeAsync(filePath).then(() => fs.renameAsync(tmpPath, filePath)),
        );
      }
    })
    .catch((unknownErr) => {
      const err = unknownToError(unknownErr);
      err.stack = err.stack + "\n" + stackErr.stack;
      return PromiseBB.reject(err);
    })
    .finally(callCleanup);
}

/**
 * copy a file in such a way that it will not replace the target if the copy is
 * somehow interrupted. The file is first copied to a temporary file in the same
 * directory as the destination, then deletes the destination and renames the temp
 * to destination. Since the rename is atomic and the deletion only happens after
 * a successful write this should minimize the risk of error.
 *
 * Goes through node's fs: a file another process is holding fails back to the caller, which
 * knows whether that is worth interrupting the user over.
 *
 * @export
 * @param {string} srcPath
 * @param {string} destPath
 * @returns {PromiseBB<void>}
 */
export function copyFileAtomic(srcPath: string, destPath: string): PromiseBB<void> {
  let cleanup: (next?: (err?: Error) => void) => void;
  let tmpPath: string;
  return new PromiseBB<void>((resolve, reject) => {
    // the copy only ever works on the temp PATH; discardDescriptor makes tmp close its
    // descriptor immediately, so no descriptor is held (or ever double-closed) here
    file(
      { template: `${destPath}.XXXXXX.tmp`, discardDescriptor: true },
      (err: any, genPath: string, _fd: number, cleanupCB: () => void) => {
        if (err) {
          return reject(err);
        }
        cleanup = cleanupCB;
        tmpPath = genPath;
        resolve();
      },
    );
  })
    .then(() => copyFile(srcPath, tmpPath))
    .then(() =>
      unlink(destPath).catch((err) => {
        const code = getErrorCode(err);
        if (code === "EPERM") {
          // if the file is currently in use, try a second time
          // 100ms later
          log("debug", "file locked, retrying delete", destPath);
          return PromiseBB.delay(100).then(() => unlink(destPath));
        } else if (code === "ENOENT") {
          // file doesn't exist anyway? no problem
          return PromiseBB.resolve();
        } else {
          return PromiseBB.reject(err);
        }
      }),
    )
    .then(() => (tmpPath !== undefined ? rename(tmpPath, destPath) : PromiseBB.resolve()))
    .catch((unknownErr) => {
      const err = unknownToError(unknownErr);
      log("info", "failed to copy", { srcPath, destPath, err: err.stack });
      // with the descriptor discarded, tmp's cleanup only unlinks; awaiting it keeps
      // the temp file from outliving the rejection
      const removeTmp =
        cleanup !== undefined
          ? new PromiseBB<void>((removed) => cleanup(() => removed()))
          : PromiseBB.resolve();
      return removeTmp.then(() => PromiseBB.reject(err));
    });
}
