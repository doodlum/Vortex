import * as path from "path";

import { getErrorCode, getErrorMessageOrDefault } from "@vortex/shared";

import { log } from "../../logging";
import * as fs from "../../util/fs";

/** the synchronous file operations the probe needs; injectable so tests can count them */
export interface ILinkProbeOps {
  writeFileSync: (filePath: string, data: string) => void;
  linkSync: (existingPath: string, newPath: string) => void;
  removeSync: (filePath: string) => void;
  removeAsync: (filePath: string) => PromiseLike<void>;
}

const defaultOps: ILinkProbeOps = {
  writeFileSync: (filePath, data) => fs.writeFileSync(filePath, data),
  linkSync: (existingPath, newPath) => fs.linkSync(existingPath, newPath),
  removeSync: (filePath) => fs.removeSync(filePath),
  removeAsync: (filePath) => fs.removeAsync(filePath),
};

/**
 * How long a successful probe of a directory is trusted. `isSupported` runs on every
 * getCurrentActivator call - several times per installed mod during a collection install, once
 * per mod type - and each probe writes, links and deletes a canary file synchronously on the
 * renderer. A directory that could hard link a moment ago still can, so a recent success is
 * reused; failures are never cached, so a directory that starts working is noticed immediately.
 */
export const LINK_PROBE_TTL_MS = 60 * 1000;

// canary directory -> time of the last successful probe
const successfulProbes = new Map<string, number>();

/** forget every cached probe result (tests) */
export function resetLinkProbeCache(): void {
  successfulProbes.clear();
}

function cleanUpCanary(canary: string, ops: ILinkProbeOps, installationPath: string): void {
  try {
    ops.removeSync(canary + ".link");
    ops.removeSync(canary);
  } catch {
    // cleanup failed, this is almost certainly due to an AV jumping in to check these new files,
    // I mean, why would I be able to create the files but not delete them?
    // just try again later - can't do that synchronously though
    setTimeout(() => {
      Promise.resolve(ops.removeAsync(canary + ".link"))
        .then(() => ops.removeAsync(canary))
        .catch((err: unknown) => {
          log(
            "error",
            "failed to clean up canary file. This indicates we were able to create " +
              "a file in the target directory but not delete it",
            { installationPath, message: getErrorMessageOrDefault(err) },
          );
        });
    }, 100);
  }
}

/**
 * Test whether hard links can be created in `installationPath` by linking a canary file.
 * Returns true if they can (or the test was inconclusive because of EMFILE, which shouldn't keep
 * us from hard linking), false if the filesystem refused.
 */
export function canHardlinkIn(
  installationPath: string,
  ops: ILinkProbeOps = defaultOps,
  now: number = Date.now(),
): boolean {
  const lastSuccess = successfulProbes.get(installationPath);
  if (lastSuccess !== undefined && now - lastSuccess < LINK_PROBE_TTL_MS) {
    return true;
  }

  const canary = path.join(installationPath, "__vortex_canary.tmp");
  let supported = true;
  let conclusive = true;

  try {
    try {
      ops.removeSync(canary + ".link");
    } catch {
      // nop
    }
    ops.writeFileSync(canary, "Should only exist temporarily, feel free to delete");
    ops.linkSync(canary, canary + ".link");
  } catch (err) {
    // EMFILE shouldn't keep us from using hard linking
    if (getErrorCode(err) !== "EMFILE") {
      // the error code we're actually getting is EISDIR, which makes no sense at all
      supported = false;
    } else {
      conclusive = false;
    }
  }

  cleanUpCanary(canary, ops, installationPath);

  if (supported && conclusive) {
    successfulProbes.set(installationPath, now);
  } else {
    successfulProbes.delete(installationPath);
  }
  return supported;
}
