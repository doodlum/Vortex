/**
 * Read version info from Windows PE executables.
 *
 * Drop-in replacement for the native exe-version package. Parses PE headers
 * directly in TypeScript — no native addons or winapi-bindings dependency.
 */

import { readVersionInfo } from "./peVersion";

// No platform guard: readVersionInfo parses the PE structures itself, so it works wherever
// Node runs. The guards that used to sit at the top of every function here ("if
// (process.platform !== \"win32\") return \"\"") were left over from the native Windows addon
// this replaced, and they made every game's version undetectable on Linux -- Vortex could
// discover Skyrim but never tell which build it was.

export function getFileVersion(exeFile: string): string {
  const info = readVersionInfo(exeFile);
  if (info === undefined) return "";
  return info.fileVersion.join(".");
}

export function getProductVersion(exeFile: string): string {
  const info = readVersionInfo(exeFile);
  if (info === undefined) return "";
  return info.productVersion.join(".");
}

export function getFileVersionLocalized(exeFile: string): string {
  const info = readVersionInfo(exeFile);
  if (info === undefined) return "";
  return info.fileVersionString;
}

export function getProductVersionLocalized(exeFile: string): string {
  const info = readVersionInfo(exeFile);
  if (info === undefined) return "";
  return info.productVersionString;
}

export default getFileVersion;
