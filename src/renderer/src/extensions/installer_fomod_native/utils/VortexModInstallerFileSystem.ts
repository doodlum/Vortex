import type { Dirent } from "node:fs";
import { readdirSync, readFileSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { open, readdir } from "node:fs/promises";
import path from "path";

import type * as fomodT from "@nexusmods/fomod-installer-native";

import { resolveNativePath } from "../../../util/casePath";
import lazyRequire from "../../../util/lazyRequire";
import { log } from "../../../util/log";

/**
 * The installer is a Windows-built library, so the paths it asks for can carry Windows separators or a
 * case the extracted archive does not use. Either one makes the lookup fail here, and the failure is
 * silent: the installer treats an unreadable directory as an empty one, so the mod's folders get
 * created with none of its files in them and the install still reports success.
 */
function tolerant(requested: string, what: string): string {
  const resolved = resolveNativePath(requested);
  if (resolved !== requested) {
    log("debug", "resolved an installer path the archive spells differently", {
      what,
      requested,
      resolved,
    });
  }
  return resolved;
}

export class VortexModInstallerFileSystem {
  private fomod: typeof fomodT;
  private mFileSystem: fomodT.NativeFileSystem;

  public constructor() {
    this.fomod = lazyRequire<typeof fomodT>(() => require("@nexusmods/fomod-installer-native"));
    this.mFileSystem = new this.fomod.NativeFileSystem(
      this.readFileContent,
      this.readDirectoryFileList,
      this.readDirectoryList,
    );
  }

  public useVortexFunctions = () => {
    this.mFileSystem.setCallbacks();
  };

  public useLibraryFunctions = () => {
    this.fomod.NativeFileSystem.setDefaultCallbacks();
  };

  /**
   * Callback
   */
  private readFileContent = (
    filePath: string,
    offset: number,
    length: number,
  ): Uint8Array | null => {
    try {
      const resolved = tolerant(filePath, "file");
      if (offset === 0 && length === -1) {
        const data = readFileSync(resolved);
        return new Uint8Array(data);
      } else if (offset >= 0 && length > 0) {
        // TODO: read the chunk we actually need, but there's no readFile()
        //const fd = fs.openSync(filePath, 'r');
        //const buffer = Buffer.alloc(length);
        //fs.readSync(fd, buffer, offset, length, 0);
        return new Uint8Array(readFileSync(resolved)).slice(offset, offset + length);
      } else {
        return null;
      }
    } catch {
      return null;
    }
  };

  /**
   * Callback
   */
  private readDirectoryFileList = (directoryPath: string): string[] | null => {
    try {
      const dir = tolerant(directoryPath, "files");
      return readdirSync(dir, { withFileTypes: true })
        .filter((x: Dirent) => x.isFile())
        .map<string>((x: Dirent) => path.join(dir, x.name));
    } catch {
      return null;
    }
  };

  /**
   * Callback
   */
  private readDirectoryList = (directoryPath: string): string[] | null => {
    try {
      const dir = tolerant(directoryPath, "directories");
      return readdirSync(dir, { withFileTypes: true })
        .filter((x: Dirent) => x.isDirectory())
        .map<string>((x: Dirent) => path.join(dir, x.name));
    } catch {
      return null;
    }
  };

  /**
   * Callback
   */
  private readFileContentAsync = async (
    filePath: string,
    offset: number,
    length: number,
  ): Promise<Uint8Array | null> => {
    try {
      let fileHandle: FileHandle | null = null;
      try {
        fileHandle = await open(tolerant(filePath, "file"), "r");
        if (length === -1) {
          const stats = await fileHandle.stat();
          length = stats.size;
        }
        const buffer = this.fomod.allocWithoutOwnership(length) ?? new Uint8Array(length);
        await fileHandle.read(buffer, 0, length, offset);
        return buffer;
      } finally {
        await fileHandle?.close();
      }
    } catch (err) {
      // ENOENT means that a file or folder is not found, it's an expected error
      if (err instanceof Error && "code" in err && err.code === "ENOENT") {
        return null;
      }
      //const { localize: t } = LocalizationManager.getInstance(this.api);
      //this.api.showErrorNotification?.(t('Error reading file content'), err);
    }
    return null;
  };

  /**
   * Callback
   */
  private readDirectoryFileListAsync = async (directoryPath: string): Promise<string[] | null> => {
    try {
      const dir = tolerant(directoryPath, "files");
      const dirs = await readdir(dir, { withFileTypes: true });
      const res = dirs.filter((x) => x.isFile()).map<string>((x) => path.join(dir, x.name));
      return res;
    } catch (err) {
      // ENOENT means that a file or folder is not found, it's an expected error
      if (err instanceof Error && "code" in err && err.code === "ENOENT") {
        return null;
      }
      //const { localize: t } = LocalizationManager.getInstance(this.api);
      //this.api.showErrorNotification?.(t('Error reading directory file list'), err);
    }
    return null;
  };

  /**
   * Callback
   */
  private readDirectoryListAsync = async (directoryPath: string): Promise<string[] | null> => {
    try {
      const dir = tolerant(directoryPath, "directories");
      const dirs = await readdir(dir, { withFileTypes: true });
      const res = dirs.filter((x) => x.isDirectory()).map<string>((x) => path.join(dir, x.name));
      return res;
    } catch (err) {
      // ENOENT means that a file or folder is not found, it's an expected error
      if (err instanceof Error && "code" in err && err.code === "ENOENT") {
        return null;
      }
      //const { localize: t } = LocalizationManager.getInstance(this.api);
      //this.api.showErrorNotification?.(t('Error reading directory list'), err);
    }
    return null;
  };
}
