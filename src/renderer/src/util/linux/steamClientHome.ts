import type { BigIntStats } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import * as path from "node:path";

import { getErrorCode } from "@vortex/shared";

async function regularFile(file: string): Promise<BigIntStats | undefined> {
  try {
    const result = await stat(file, { bigint: true });
    return result.isFile() ? result : undefined;
  } catch (err) {
    if (["ENOENT", "ENOTDIR"].includes(getErrorCode(err) ?? "")) return undefined;
    throw err;
  }
}

/** Proton's native Steam bridge looks in HOME/.steam/sdk32 or sdk64, including Snap's private home. */
export async function findSteamClientHome(
  steamPath: string,
  hostHome: string | undefined = process.env.HOME,
): Promise<string | undefined> {
  const homes = new Set<string>();
  if (hostHome !== undefined && path.isAbsolute(hostHome)) homes.add(path.resolve(hostHome));
  let canonicalSteamPath: string;
  try {
    canonicalSteamPath = await realpath(steamPath);
  } catch (err) {
    if (["ENOENT", "ENOTDIR"].includes(getErrorCode(err) ?? "")) return undefined;
    throw err;
  }
  for (const installation of [path.resolve(steamPath), canonicalSteamPath]) {
    let candidate = installation;
    for (let level = 0; level < 5 && path.dirname(candidate) !== candidate; level++) {
      homes.add(candidate);
      candidate = path.dirname(candidate);
    }
  }
  for (const [sdk, client] of [
    ["sdk64", "linux64"],
    ["sdk32", "linux32"],
  ]) {
    const library = await regularFile(path.join(steamPath, client, "steamclient.so"));
    if (library === undefined) continue;
    for (const home of homes) {
      const link = await regularFile(path.join(home, ".steam", sdk, "steamclient.so"));
      if (link !== undefined && link.dev === library.dev && link.ino === library.ino) return home;
    }
  }
  return undefined;
}
