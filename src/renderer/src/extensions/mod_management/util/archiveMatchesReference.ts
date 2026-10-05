/**
 * Whether an archive already in the download folder is the file a dependency rule asks for.
 *
 * A non-fuzzy reference with a file hash names one exact file, so an archive that merely shares its
 * file name (a truncated copy, or a different file from a browser download) must not stand in for
 * it. Fuzzy references (`+prefer`, ranges, `*`) legitimately resolve to files with other hashes, so
 * they are never checked.
 */
import { stat } from "node:fs/promises";
import * as path from "path";

import { log } from "../../../logging";
import type { IExtensionApi } from "../../../types/IExtensionContext";
import { fileMD5 } from "../../../util/checksum";
import { setDownloadHash } from "../../download_management/actions/state";
import { downloadPathForGame } from "../../download_management/selectors";
import type { IDownload } from "../../download_management/types/IDownload";
import { knownGames } from "../../gamemode_management/selectors";
import { convertGameIdReverse } from "../../nexus_integration/util/convertGameId";
import type { IModReference } from "../types/IMod";
import { isFuzzyVersion } from "./isFuzzyVersion";

function pinsFileHash(reference: IModReference | undefined): boolean {
  return !!reference?.fileMD5 && !isFuzzyVersion(reference.versionMatch);
}

/**
 * True when the download's recorded hash is known and isn't the one the reference pins. Cheap: it
 * never touches the disk, so a download whose hash isn't known yet doesn't contradict.
 */
export function contradictsReference(
  download: IDownload | undefined,
  reference: IModReference | undefined,
): boolean {
  return (
    pinsFileHash(reference) &&
    download?.fileMD5 !== undefined &&
    download.fileMD5 !== reference.fileMD5
  );
}

function archivePath(api: IExtensionApi, download: IDownload): string {
  const state = api.getState();
  const gameId = convertGameIdReverse(knownGames(state), download.game[0]) || download.game[0];
  return path.join(downloadPathForGame(state, gameId), download.localPath);
}

async function hashDownload(api: IExtensionApi, download: IDownload): Promise<string | undefined> {
  try {
    const hash = await fileMD5(archivePath(api, download));
    api.store.dispatch(setDownloadHash(download.id, hash));
    return hash;
  } catch (err) {
    log("warn", "failed to hash existing archive", { downloadId: download.id, err });
    return undefined;
  }
}

// the size on disk, which a recorded hash can't vouch for once the file changed after it was hashed
async function sizeOnDisk(api: IExtensionApi, download: IDownload): Promise<number | undefined> {
  return stat(archivePath(api, download)).then(
    (stats) => stats.size,
    () => download.size,
  );
}

/**
 * Whether the download can be reused for the reference. A known size that isn't the reference's
 * rejects it first; then the recorded hash decides, or, when none is recorded, the file is hashed
 * (and the hash recorded). An archive that can't be hashed keeps the old behaviour and is reused.
 */
export async function archiveMatchesReference(
  api: IExtensionApi,
  download: IDownload,
  reference: IModReference,
): Promise<boolean> {
  if (!pinsFileHash(reference) || !download.localPath) {
    return true;
  }
  const size = (reference.fileSize ?? 0) > 0 ? await sizeOnDisk(api, download) : undefined;
  if (size !== undefined && size > 0 && size !== reference.fileSize) {
    return false;
  }
  const hash = download.fileMD5 ?? (await hashDownload(api, download));
  return hash === undefined || hash === reference.fileMD5;
}
