/**
 * Whether an archive already in the download folder is the file a dependency rule asks for.
 *
 * A non-fuzzy reference with a file hash names one exact file, so an archive that merely shares its
 * file name (a truncated copy, or a different file from a browser download) must not stand in for
 * it. Fuzzy references (`+prefer`, ranges, `*`) legitimately resolve to files with other hashes, so
 * they are never checked.
 */
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

async function hashDownload(api: IExtensionApi, download: IDownload): Promise<string | undefined> {
  if (!download.localPath) {
    return undefined;
  }
  const state = api.getState();
  const gameId = convertGameIdReverse(knownGames(state), download.game[0]) || download.game[0];
  const filePath = path.join(downloadPathForGame(state, gameId), download.localPath);
  try {
    const hash = await fileMD5(filePath);
    api.store.dispatch(setDownloadHash(download.id, hash));
    return hash;
  } catch (err) {
    log("warn", "failed to hash existing archive", { downloadId: download.id, err });
    return undefined;
  }
}

/**
 * Whether the finished download can be reused for the reference. Uses the recorded hash when there
 * is one; otherwise rejects on a known size mismatch before hashing the file (and recording the
 * hash). An archive that can't be hashed keeps the old behaviour and is reused.
 */
export async function archiveMatchesReference(
  api: IExtensionApi,
  download: IDownload,
  reference: IModReference,
): Promise<boolean> {
  if (!pinsFileHash(reference)) {
    return true;
  }
  let hash = download.fileMD5;
  if (hash === undefined) {
    if (reference.fileSize > 0 && download.size > 0 && download.size !== reference.fileSize) {
      return false;
    }
    hash = await hashDownload(api, download);
  }
  return hash === undefined || hash === reference.fileMD5;
}
