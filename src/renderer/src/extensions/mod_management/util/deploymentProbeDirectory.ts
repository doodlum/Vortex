import { lstatSync } from "node:fs";
import * as path from "node:path";

import { getErrorCode } from "@vortex/shared";

import * as fs from "../../../util/fs";

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
