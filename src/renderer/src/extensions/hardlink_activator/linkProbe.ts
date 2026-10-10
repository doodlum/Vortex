import * as path from "path";

import { getErrorCode, getErrorMessageOrDefault } from "@vortex/shared";

import { log } from "../../logging";
import * as fs from "../../util/fs";
import { scopedProbe } from "../mod_management/util/probeScope";

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

export type LinkProbeResult = "linked" | "refused" | "inconclusive";

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

/** link a canary file in `installationPath` */
export function probeHardlink(
  installationPath: string,
  ops: ILinkProbeOps = defaultOps,
): LinkProbeResult {
  const canary = path.join(installationPath, "__vortex_canary.tmp");
  let result: LinkProbeResult = "linked";

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
    // the error code we're actually getting otherwise is EISDIR, which makes no sense at all
    result = getErrorCode(err) === "EMFILE" ? "inconclusive" : "refused";
  }

  cleanUpCanary(canary, ops, installationPath);
  return result;
}

/**
 * Whether hard links can be created in `installationPath`. True if the canary linked or the test
 * was inconclusive (EMFILE), false if the filesystem refused. Within one probe scope (one
 * getCurrentActivator call) a conclusive answer for the folder is reused; outside a scope, and
 * after an inconclusive answer, it probes every time.
 */
export function canHardlinkIn(installationPath: string, ops: ILinkProbeOps = defaultOps): boolean {
  const result = scopedProbe(
    `hardlink-canary:${installationPath}`,
    () => probeHardlink(installationPath, ops),
    (res) => res !== "inconclusive",
  );
  return result !== "refused";
}
