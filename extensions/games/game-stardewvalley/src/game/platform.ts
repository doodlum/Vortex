import { existsSync } from "node:fs";
import path from "node:path";

/** Proton installs use Windows game and SMAPI files even when Vortex itself runs on Linux. */
export function installedGamePlatform(
  gamePath?: string,
  host: NodeJS.Platform = process.platform,
): NodeJS.Platform {
  return host === "linux" &&
    gamePath !== undefined &&
    existsSync(path.join(gamePath, "Stardew Valley.exe"))
    ? "win32"
    : host;
}
