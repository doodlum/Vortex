import { execFile } from "child_process";
import { existsSync } from "fs";
import { promisify } from "util";

import psList from "ps-list";

const execFileAsync = promisify(execFile);

/**
 * A single process snapshot from the provider.
 * - `pid`/`ppid` are OS process IDs (numeric identifiers only; not time/memory units).
 * - `name` is the executable basename used to build exe IDs.
 * - `cmd` is the raw command line when available.
 * - `path` is the absolute executable path when available (may be derived from cmd).
 */
export interface IProcessInfo {
  /** OS process id (numeric identifier only; no time/memory units). */
  pid: number;
  /** Parent process id (numeric identifier only); 0 for root/system processes. */
  ppid: number;
  /** Executable basename used to normalize exe IDs. */
  name: string;
  /** Raw command line, if provided by the OS/provider. */
  cmd?: string;
  /** Absolute executable path when available; may be derived from cmd. */
  path?: string;
}

/**
 * Supplies a full process list snapshot used for matching running tools.
 * Numeric fields in the contract are OS process IDs only.
 */
export interface IProcessProvider {
  /**
   * Returns all visible processes. Optional fields may be unavailable on some OSes.
   */
  list(): Promise<IProcessInfo[]>;
  /**
   * True when the pids reported belong to a different pid namespace than this process, so ancestry
   * cannot be established by comparing against `process.pid`.
   */
  foreignNamespace?: boolean;
}

/** Default provider backed by ps-list; cmd/path availability varies by platform. */
export class PsListProcessProvider implements IProcessProvider {
  /**
   * ps-list does not expose a dedicated path field; callers may parse cmd.
   */
  public async list(): Promise<IProcessInfo[]> {
    const processes = await psList({ all: true });
    return processes.map((proc) => ({
      pid: proc.pid,
      ppid: proc.ppid,
      name: proc.name,
      cmd: proc.cmd,
      // ps-list doesn't provide a 'path' property; it must be derived from 'cmd'
    }));
  }
}

/** True when this process runs inside a Flatpak sandbox. */
export const runningInFlatpak = (): boolean => existsSync("/.flatpak-info");

/**
 * The host's process list, for when Vortex runs in a Flatpak.
 *
 * Flatpak gives an app its own pid namespace, so `ps` inside the sandbox sees only the app itself --
 * five processes against the host's four hundred. Every game on Linux is started by Steam, outside
 * that namespace, so the process monitor could never see a running game: the Play button never
 * changed and nothing waiting on the game's exit ever fired. Nothing in the matching logic could fix
 * that, because the process was not in the list at all.
 *
 * `flatpak-spawn --host` runs a command outside the sandbox through the portal, which needs
 * `--talk-name=org.freedesktop.Flatpak` in the manifest; without it the call silently returns nothing.
 * `ps` is asked for the same four fields ps-list provides, so the rest of the monitor is unchanged.
 */
export class FlatpakHostProcessProvider implements IProcessProvider {
  public readonly foreignNamespace = true;

  public async list(): Promise<IProcessInfo[]> {
    const { stdout } = await execFileAsync(
      "flatpak-spawn",
      // --directory is not optional: flatpak-spawn forwards its own working directory to the portal,
      // and the sandbox's (`/app/vortex`) does not exist outside it, so the portal refuses the whole
      // call with "Failed to change to directory". The `cwd` here is the same guard for the wrapper
      // process itself.
      ["--host", "--directory=/", "ps", "-A", "-o", "pid=,ppid=,comm=,args="],
      { maxBuffer: 16 * 1024 * 1024, cwd: "/" },
    );
    const result: IProcessInfo[] = [];
    for (const line of stdout.split("\n")) {
      // pid, ppid and comm are single tokens; everything after them is the command line, which may
      // contain spaces (and, under Wine, backslashes).
      const parsed = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(line);
      if (parsed === null) {
        continue;
      }
      result.push({
        pid: Number(parsed[1]),
        ppid: Number(parsed[2]),
        name: parsed[3],
        cmd: parsed[4].length > 0 ? parsed[4] : undefined,
      });
    }
    return result;
  }
}

/**
 * The provider the monitor uses unless one is injected: the host's list when sandboxed, the local
 * one otherwise. Declared last, because it names both classes.
 */
export const defaultProcessProvider: IProcessProvider = runningInFlatpak()
  ? new FlatpakHostProcessProvider()
  : new PsListProcessProvider();
