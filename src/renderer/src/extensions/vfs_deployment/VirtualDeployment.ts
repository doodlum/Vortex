import * as path from "path";

import { getErrorCode } from "@vortex/shared";
import type { TFunction } from "i18next";
import turbowalk from "turbowalk";

import type { IState } from "../../types/IState";
import * as fs from "../../util/fs";
import type { Normalize } from "../../util/getNormalizeFunc";
import type {
  IDeployedFile,
  IDeploymentMethod,
  IFileChange,
  IUnavailableReason,
} from "../mod_management/types/IDeploymentMethod";
import type BlacklistSet from "../mod_management/util/BlacklistSet";

export const VFS_DEPLOYMENT_ID = "aether_vfs";

export type SupportCheck = (
  state: IState,
  gameId: string,
  modTypeId: string,
) => IUnavailableReason | undefined;

interface IDeploymentContext {
  /** Keyed by the normalized `target/relPath`, as a linking deployment keys its files. */
  deployment: Map<string, IDeployedFile>;
  onComplete: () => void;
}

function deploymentKey(normalize: Normalize, target: string, relPath: string): string {
  return normalize(path.join(target, relPath));
}

/**
 * A deployment method that puts nothing into the game folder. It records, per mod type, which
 * staging file serves each deployed path, exactly as a linking method decides it (mods activate
 * in ascending priority, so the last writer wins; blacklists and per-mod targets apply), and
 * the deployment is then served by a virtual file system (aether-vfs) to the programs Vortex
 * starts. `finalize`'s result is that record: the deployment manifest, kept in staging.
 */
export default class VirtualDeployment implements IDeploymentMethod {
  public readonly id = VFS_DEPLOYMENT_ID;
  public readonly name = "Virtual File System";
  public readonly description =
    "Shows mods to games and tools through a virtual file system. Nothing is linked, moved or " +
    "copied into the game folder.";
  // Nothing is on disk, so a purge from any instance or version is always safe.
  public readonly isFallbackPurgeSafe = true;
  public readonly priority = 1;
  public readonly virtual = true;

  private mQueue: Promise<void> = Promise.resolve();
  private mContext: IDeploymentContext | undefined;
  private mNormalize: Normalize = (input) => input;
  private mSupport: SupportCheck;

  constructor(support: SupportCheck) {
    this.mSupport = support;
  }

  public detailedDescription(t: TFunction): string {
    return t(
      "Vortex shows your mods to the game through a virtual file system: when you start the " +
        "game or a tool from Vortex, it sees the game folder with your mods in it, while the " +
        "folder on disk stays exactly as the game store installed it.\n" +
        "Advantages:\n" +
        " - the game installation is never modified\n" +
        " - mods can be on any drive\n" +
        " - switching profiles or mods takes no file operations\n" +
        "Disadvantages:\n" +
        " - mods are only active when the game is started from Vortex, not from the store's " +
        "own launcher\n" +
        " - files the game writes into its folder are kept in Vortex's Overwrite folder",
    );
  }

  public isSupported(state: IState, gameId: string, modTypeId: string): IUnavailableReason {
    return this.mSupport(state, gameId, modTypeId);
  }

  public userGate(): PromiseLike<void> {
    return Promise.resolve();
  }

  public prepare(
    dataPath: string,
    clean: boolean,
    lastDeployment: IDeployedFile[],
    normalize: Normalize,
  ): PromiseLike<void> {
    let release: () => void = () => undefined;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.mQueue;
    this.mQueue = this.mQueue.then(() => turn);
    return previous.then(() => {
      this.mNormalize = normalize;
      const deployment = new Map<string, IDeployedFile>();
      if (!clean) {
        for (const file of lastDeployment) {
          deployment.set(deploymentKey(normalize, file.target ?? "", file.relPath), file);
        }
      }
      this.mContext = { deployment, onComplete: release };
    });
  }

  public activate(
    sourcePath: string,
    sourceName: string,
    deployPath: string,
    blackList: BlacklistSet,
  ): Promise<void> {
    const context = this.mContext;
    if (context === undefined) {
      return Promise.reject(new Error("No deployment in progress"));
    }
    return Promise.resolve(
      turbowalk(
        sourcePath,
        (entries) => {
          for (const entry of entries) {
            if (entry.isDirectory) {
              continue;
            }
            const relPath = path.relative(sourcePath, entry.filePath);
            if (blackList.has(this.mNormalize(path.join(sourceName, relPath)))) {
              continue;
            }
            // Mods activate in ascending priority, so a later one replaces an earlier one.
            context.deployment.set(deploymentKey(this.mNormalize, deployPath, relPath), {
              relPath,
              source: sourceName,
              target: deployPath,
              time: entry.mtime * 1000,
            });
          }
        },
        { skipHidden: false },
      ),
    ).catch((err: unknown) => {
      const code = getErrorCode(err);
      if (code === "ENOENT" || code === "ENOTFOUND") {
        return undefined;
      }
      throw err;
    });
  }

  public deactivate(sourcePath: string, dataPath: string, sourceName: string): PromiseLike<void> {
    const context = this.mContext;
    if (context === undefined) {
      return Promise.resolve();
    }
    return Promise.resolve(
      turbowalk(
        sourcePath,
        (entries) => {
          for (const entry of entries) {
            if (entry.isDirectory) {
              continue;
            }
            const key = deploymentKey(
              this.mNormalize,
              dataPath,
              path.relative(sourcePath, entry.filePath),
            );
            if (context.deployment.get(key)?.source === sourceName) {
              context.deployment.delete(key);
            }
          }
        },
        { skipHidden: false },
      ),
    ).catch((err: unknown) => {
      if (getErrorCode(err) === "ENOENT") {
        return undefined;
      }
      throw err;
    });
  }

  public finalize(
    gameId: string,
    dataPath: string,
    installationPath: string,
    progressCB?: (files: number, total: number) => void,
  ): PromiseLike<IDeployedFile[]> {
    const context = this.mContext;
    if (context === undefined) {
      return Promise.reject(new Error("No deployment in progress"));
    }
    const files = Array.from(context.deployment.values());
    progressCB?.(files.length, files.length);
    this.complete(context);
    return Promise.resolve(files);
  }

  public cancel(gameId: string, dataPath: string, installationPath: string): PromiseLike<void> {
    if (this.mContext !== undefined) {
      this.complete(this.mContext);
    }
    return Promise.resolve();
  }

  public prePurge(installPath: string): PromiseLike<void> {
    return Promise.resolve();
  }

  /** Nothing is on disk: clearing the deployment is saving an empty manifest, which core does. */
  public purge(
    installPath: string,
    dataPath: string,
    gameId?: string,
    onProgress?: (num: number, total: number) => void,
  ): PromiseLike<void> {
    return Promise.resolve();
  }

  public postPurge(): PromiseLike<void> {
    return Promise.resolve();
  }

  /**
   * A virtual deployment has no deployed files of its own to change: what programs write lands
   * in the Overwrite folder, which Vortex reports separately.
   */
  public externalChanges(
    gameId: string,
    installPath: string,
    dataPath: string,
    activation: IDeployedFile[],
  ): PromiseLike<IFileChange[]> {
    return Promise.resolve([]);
  }

  public getDeployedPath(input: string): string {
    return input;
  }

  /** Deployed while the staging file that serves it exists. */
  public isDeployed(
    installPath: string,
    dataPath: string,
    file: IDeployedFile,
  ): PromiseLike<boolean> {
    return fs
      .statAsync(path.join(installPath, file.source, file.sourceRelPath ?? file.relPath))
      .then(() => true)
      .catch(() => false);
  }

  private complete(context: IDeploymentContext) {
    if (this.mContext === context) {
      this.mContext = undefined;
    }
    context.onComplete();
  }
}
