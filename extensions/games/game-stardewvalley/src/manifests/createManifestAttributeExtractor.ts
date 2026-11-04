import { stat } from "node:fs/promises";
import path from "node:path";

import { log, selectors } from "@nexusmods/vortex-api";
import type { types } from "@nexusmods/vortex-api";
import { getErrorCode, getErrorMessageOrDefault } from "@vortex/shared";
/**
 * Creates the manifest-based mod attribute extractor used during installation.
 */
import * as semver from "semver";

import { GAME_ID, SMAPI_MOD_ID } from "../common";
import { getModManifests } from "./getModManifests";
import { parseManifest } from "./parseManifest";

/**
 * Factory for the Stardew Valley manifest attribute extractor.
 *
 * The extractor runs for installed archives and enriches mod attributes with
 * data derived from parsed `manifest.json` files, including:
 * - `additionalLogicalFileNames`
 * - `minSMAPIVersion`
 * - `customFileName` (except for SMAPI itself)
 * - `manifestVersion`
 */

/** Recognize the installed loader independently of optional download metadata. */
async function hasSMAPILoader(modPath: string): Promise<boolean> {
  const regularFile = async (name: string) => {
    try {
      return (await stat(path.join(modPath, name))).isFile();
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes(getErrorCode(error) ?? "")) return false;
      throw error;
    }
  };
  return (
    (await regularFile("StardewModdingAPI.dll")) &&
    ((await regularFile("StardewModdingAPI.exe")) || (await regularFile("StardewModdingAPI")))
  );
}

export function createManifestAttributeExtractor(context: types.IExtensionContext) {
  return async (modInfo: any, modPath: string): Promise<{ [key: string]: any }> => {
    if (selectors.activeGameId(context.api.getState()) !== GAME_ID || modPath === undefined) {
      return {};
    }

    const manifests = await getModManifests(modPath);

    const parsedManifests = (
      await Promise.all(
        manifests.map(async (manifest) => {
          try {
            return await parseManifest(manifest);
          } catch (err) {
            log("warn", "Failed to parse manifest", {
              manifestFile: manifest,
              error: getErrorMessageOrDefault(err),
            });
            return undefined;
          }
        }),
      )
    ).filter((manifest) => manifest !== undefined);

    if (parsedManifests.length === 0) {
      return {};
    }

    const refManifest = parsedManifests[0];

    const additionalLogicalFileNames = parsedManifests
      .filter((manifest) => manifest.UniqueID !== undefined)
      .map((manifest) => manifest.UniqueID.toLowerCase());

    const minSMAPIVersion = parsedManifests
      .map((manifest) => manifest.MinimumApiVersion)
      .filter((version) => semver.valid(version))
      .sort((lhs, rhs) => semver.compare(rhs, lhs))[0];

    const result = {
      additionalLogicalFileNames,
      minSMAPIVersion,
    };

    if (refManifest !== undefined) {
      const nexusModId = modInfo.download?.modInfo?.nexus?.ids?.modId;
      const isSMAPI =
        nexusModId === SMAPI_MOD_ID ||
        nexusModId === String(SMAPI_MOD_ID) ||
        (await hasSMAPILoader(modPath));
      if (!isSMAPI) {
        result["customFileName"] = refManifest.Name;
      }

      if (typeof refManifest.Version === "string") {
        result["manifestVersion"] = refManifest.Version;
      }
    }

    return result;
  };
}
