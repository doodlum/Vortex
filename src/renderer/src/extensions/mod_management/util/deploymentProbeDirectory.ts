import { lstatSync } from "node:fs";
import * as path from "node:path";

import { getErrorCode } from "@vortex/shared";

import * as fs from "../../../util/fs";
import type { IUnavailableReason } from "../types/IDeploymentMethod";

/** Probe a missing output's existing ancestor without creating directories in a selector. */
export function deploymentProbeDirectory(target: string): string {
  let current = path.resolve(target);
  for (;;) {
    try {
      if (!fs.statSync(current).isDirectory()) {
        throw Object.assign(new Error("Deployment output is not a directory"), { code: "ENOTDIR" });
      }
      fs.accessSync(current, fs.constants.W_OK);
      return current;
    } catch (err) {
      if (getErrorCode(err) !== "ENOENT") throw err;
      // A dangling symlink is not a missing directory that deployment can create.
      let entry;
      try {
        entry = lstatSync(current);
      } catch (lstatError) {
        if (getErrorCode(lstatError) !== "ENOENT") throw lstatError;
      }
      if (entry !== undefined) throw err;
      const parent = path.dirname(current);
      if (parent === current) throw err;
      current = parent;
    }
  }
}

/** Staging must already exist and allow reading, updating and traversing mod files. */
export function stagingDirectoryUnavailable(stagingPath: string): IUnavailableReason {
  try {
    if (!fs.statSync(stagingPath).isDirectory()) {
      throw new Error("Mod staging path is not a directory");
    }
    fs.accessSync(stagingPath, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
    return undefined;
  } catch {
    return {
      description: (t) => t("Can't access mod staging directory."),
      order: 2,
      solution: (t) =>
        t(
          'Ensure "{{stagingPath}}" exists and your current user account can read, write and access its contents.',
          { replace: { stagingPath } },
        ),
    };
  }
}
