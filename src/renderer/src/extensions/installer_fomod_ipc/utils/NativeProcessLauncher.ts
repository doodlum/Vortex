import { spawn } from "node:child_process";
import path from "node:path";

import type { IProcessLauncher, ProcessLaunchOptions } from "@nexusmods/fomod-installer-ipc";
import { SecurityLevel } from "@nexusmods/fomod-installer-ipc";

import type { INativeFomodRuntime } from "./BundledRuntime";

/** Native Framework Mono; this launcher does not claim Windows AppContainer isolation. */
export class NativeProcessLauncher implements IProcessLauncher {
  constructor(private readonly runtime: INativeFomodRuntime) {}

  getSecurityLevel(): SecurityLevel {
    return SecurityLevel.Regular;
  }

  async launch(exePath: string, args: string[], options: ProcessLaunchOptions) {
    if (path.resolve(exePath) !== path.resolve(this.runtime.helper)) {
      throw new Error("Native FOMOD launcher received an unexpected helper path");
    }
    const root = this.runtime.root;
    const env = { ...process.env, ...options.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith("MONO_") || key.startsWith("DOTNET_") || key === "LD_PRELOAD")
        delete env[key];
    }
    Object.assign(env, {
      PATH: path.join(root, "usr/bin") + path.delimiter + (env.PATH ?? ""),
      LD_LIBRARY_PATH: path.join(root, "usr/lib"),
      MONO_CFG_DIR: path.join(root, "etc/mono"),
      MONO_GAC_PREFIX: path.join(root, "usr"),
      MONO_PATH: [
        path.join(root, "usr/lib/mono/4.5"),
        path.join(root, "usr/lib/mono/4.5/Facades"),
      ].join(path.delimiter),
    });
    return spawn(
      this.runtime.mono,
      ["--config", this.runtime.config, this.runtime.helper, ...args],
      {
        ...options,
        env,
      },
    );
  }

  async cleanup(): Promise<void> {
    /* BaseIPCConnection owns the child process lifecycle. */
  }
}
