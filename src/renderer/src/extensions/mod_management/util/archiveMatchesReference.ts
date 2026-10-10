import { stat } from "node:fs/promises";
import * as path from "path";

import { log } from "../../../logging";
import type { IExtensionApi } from "../../../types/IExtensionContext";
import { fileMD5 } from "../../../util/checksum";
import { UserCanceled } from "../../../util/CustomErrors";
import { downloadPathForGame } from "../../download_management/selectors";
import type { IDownload } from "../../download_management/types/IDownload";
import { knownGames } from "../../gamemode_management/selectors";
import { convertGameIdReverse } from "../../nexus_integration/util/convertGameId";
import type { IModReference } from "../types/IMod";
import { isFuzzyVersion } from "./isFuzzyVersion";

export function pinsFileHash(reference: IModReference | undefined): boolean {
  return !!reference?.fileMD5 && !isFuzzyVersion(reference.versionMatch);
}

/** A recorded mismatch can reject a candidate cheaply; a match cannot prove current disk bytes. */
export function contradictsReference(
  download: IDownload | undefined,
  reference: IModReference | undefined,
): boolean {
  return (
    pinsFileHash(reference) &&
    ((download?.fileMD5 !== undefined &&
      download.fileMD5.toLowerCase() !== reference.fileMD5.toLowerCase()) ||
      (download?.state === "finished" &&
        reference.fileSize !== undefined &&
        download.size !== undefined &&
        download.size !== reference.fileSize))
  );
}

/** Release the caller on cancellation; a late read/hash result has no state-writing side effects. */
export function withArchiveCancellation<T>(work: PromiseLike<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return Promise.resolve(work);
  return new Promise<T>((resolve, reject) => {
    const canceled = () => {
      signal.removeEventListener("abort", canceled);
      reject(new UserCanceled(false));
    };
    signal.addEventListener("abort", canceled, { once: true });
    if (signal.aborted) canceled();
    Promise.resolve(work)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", canceled));
  });
}

/**
 * Read-only verification of a settled, reused archive. Missing/inaccessible bytes and files changed
 * during hashing are unverified, rather than matches. Fuzzy references retain their existing rules.
 */
export async function archiveMatchesReference(
  api: IExtensionApi,
  download: IDownload,
  reference: IModReference,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) throw new UserCanceled(false);
  if (!pinsFileHash(reference)) return true;
  if (!download?.localPath || contradictsReference(download, reference)) return false;
  const state = api.getState();
  const gameId = convertGameIdReverse(knownGames(state), download.game[0]) || download.game[0];
  const filePath = path.join(downloadPathForGame(state, gameId), download.localPath);
  const verify = async () => {
    try {
      const before = await stat(filePath);
      if (
        !before.isFile() ||
        (reference.fileSize !== undefined && before.size !== reference.fileSize)
      )
        return false;
      const hash = await fileMD5(filePath);
      const after = await stat(filePath);
      return (
        before.size === after.size &&
        before.mtimeMs === after.mtimeMs &&
        before.ctimeMs === after.ctimeMs &&
        before.ino === after.ino &&
        hash.toLowerCase() === reference.fileMD5.toLowerCase()
      );
    } catch {
      log("warn", "unable to verify existing archive", { downloadId: download.id });
      return false;
    }
  };
  return withArchiveCancellation(verify(), signal);
}
