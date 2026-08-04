import * as path from "path";

import { fs, types, util } from "@nexusmods/vortex-api";

const LOOT_LIST_REVISION = "v0.29";
const DOWNLOAD_THROTTLE_MS = 30 * 60 * 1000; // 30 minutes
const DOWNLOAD_ATTEMPTS = 3;

function getListUrl(gameId?: string) {
  return gameId != null
    ? `https://raw.githubusercontent.com/loot/${gameId}/${LOOT_LIST_REVISION}/masterlist.yaml`
    : `https://raw.githubusercontent.com/loot/prelude/${LOOT_LIST_REVISION}/prelude.yaml`;
}

async function requestList(url: string): Promise<string | Buffer> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      return await util.rawRequest(url);
    } catch (err) {
      lastError = err;
      if (attempt < DOWNLOAD_ATTEMPTS) {
        // Steam and the desktop network can still be settling while Vortex restores its last
        // profile. A short bounded retry avoids reporting a broken masterlist for that transient.
        await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
      }
    }
  }
  throw lastError;
}

// TODO: this is for transitioning from loot 0.17 -> 0.18, remove it at some point
async function tryRemoveDotGit(localPath: string) {
  try {
    const gitDir = path.join(path.dirname(localPath), ".git");
    await fs.statAsync(gitDir);
    await fs.removeAsync(gitDir);
  } catch (err) {
    // ignore, this is fine
  }
}

let lastUpdated: number = 0;
export async function isMasterlistOutdated(
  api: types.IExtensionApi,
  gameId: string,
  localPath: string,
): Promise<boolean> {
  if (Date.now() - lastUpdated < DOWNLOAD_THROTTLE_MS) {
    return false;
  }
  const masterlistUrl = getListUrl(gameId);
  try {
    const remoteMasterlist = await requestList(masterlistUrl);
    const localHash = await api.genMd5Hash(localPath);
    const remoteHash = await api.genMd5Hash(remoteMasterlist);
    return localHash.md5sum !== remoteHash.md5sum;
  } catch (err) {
    return true;
  }
}

export async function downloadMasterlist(gameId: string, localPath: string) {
  lastUpdated = Date.now();
  await tryRemoveDotGit(localPath);
  const buf = await requestList(getListUrl(gameId));
  await fs.ensureDirWritableAsync(path.dirname(localPath));
  await fs.writeFileAsync(localPath, buf);
}

export async function downloadPrelude(localPath: string) {
  await tryRemoveDotGit(localPath);
  const buf = await requestList(getListUrl());
  await fs.ensureDirWritableAsync(path.dirname(localPath));
  await fs.writeFileAsync(localPath, buf);
}

export async function masterlistExists(gameId: string) {
  const localPath = masterlistFilePath(gameId);
  try {
    await fs.statAsync(localPath);
    return true;
  } catch (err) {
    return false;
  }
}

export function masterlistFilePath(gameMode: string) {
  return path.join(util.getVortexPath("userData"), gameMode, "masterlist", "masterlist.yaml");
}
