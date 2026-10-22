import type { IExtensionApi, ISupportedResult } from "../../types/api";
import type { ITestSupportedDetails } from "../mod_management/types/TestSupported";

/** Identify legacy C# from archive metadata. Running its helper belongs to installation. */
export const testSupported = async (
  _api: IExtensionApi,
  files: string[],
  gameId: string,
  details?: ITestSupportedDetails,
): Promise<ISupportedResult> => {
  const unsupported = { supported: false, requiredFiles: [] };
  if (!["oblivion", "fallout3", "falloutnv"].includes(gameId)) return unsupported;
  if (details?.hasCSScripts === false) return unsupported;

  const entries = files.map((file) => file.replace(/\\/g, "/"));
  if (
    entries.some(
      (entry) => entry.startsWith("/") || /[:\0]/.test(entry) || entry.split("/").includes(".."),
    )
  )
    return unsupported;
  if (!entries.some((entry) => /(?:^|\/)fomod\/script\.cs$/i.test(entry))) return unsupported;

  // C# can request any listed asset, not just predictable XML/image inputs.
  return { supported: true, requiredFiles: [...files] };
};
