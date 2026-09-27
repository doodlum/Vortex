import type { IState } from "../../../types/IState";
import type { IDependency } from "../types/IDependency";

/**
 * Start order for a waiting install. A dependency (a collection member, or a mod's requirement) is
 * ranked by its archive size, largest first, so the longest extractions start early instead of
 * running alone at the end. An install the user started directly goes ahead of dependencies, in
 * the order it was started.
 */
export function installPriority(sourceModId: string | undefined, size: number): number {
  return sourceModId === undefined ? Number.MAX_SAFE_INTEGER : size;
}

export function archiveSize(state: IState, archiveId: string | undefined): number {
  return (archiveId != null ? state.persistent.downloads.files[archiveId]?.size : undefined) ?? 0;
}

/**
 * Archive size of a dependency: from its download once there is one, else what the collection
 * or the lookup says it will be. 0 when nothing knows.
 */
export function dependencySize(state: IState, dep: IDependency, downloadId?: string): number {
  const size =
    archiveSize(state, downloadId ?? dep.download) ||
    dep.reference?.fileSize ||
    dep.lookupResults?.[0]?.value?.fileSizeBytes;
  return typeof size === "number" && Number.isFinite(size) ? size : 0;
}
