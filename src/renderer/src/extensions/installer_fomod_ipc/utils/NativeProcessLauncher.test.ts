import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn, default: { spawn: mocks.spawn } }));
vi.mock("@nexusmods/fomod-installer-ipc", () => ({ SecurityLevel: { Regular: "regular" } }));

import { NativeProcessLauncher } from "./NativeProcessLauncher";

const root = path.resolve("/owned/runtime with spaces");
const runtime = {
  root,
  mono: path.join(root, "usr/bin/mono-sgen"),
  helper: path.join(root, "helper/ModInstallerIPC.exe"),
  config: path.join(root, "etc/mono/config"),
};
const options = {
  cwd: path.dirname(runtime.helper),
  env: {
    PATH: "preserved-path",
    DISPLAY: ":91",
    LD_LIBRARY_PATH: "/wrong",
    LD_PRELOAD: "/wrong",
    MONO_ENV_OPTIONS: "--wrong",
    DOTNET_ROOT: "/wrong",
  },
  stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
  detached: false,
  windowsHide: true,
};
beforeEach(() => {
  vi.clearAllMocks();
});

describe("native legacy C# process launcher", () => {
  it("uses the exact private Mono/helper/config and retains IPC arguments without shell parsing", async () => {
    const child = { pid: 42 };
    mocks.spawn.mockReturnValue(child);
    const launcher = new NativeProcessLauncher(runtime);
    expect(launcher.getSecurityLevel()).toBe("regular");
    const args = ["--tcp", "127.0.0.1", "1234", "literal;argument with spaces"];
    expect(await launcher.launch(runtime.helper, args, options)).toBe(child);
    const [command, commandArgs, spawnOptions] = mocks.spawn.mock.calls[0];
    expect(command).toBe(runtime.mono);
    expect(commandArgs).toEqual(["--config", runtime.config, runtime.helper, ...args]);
    expect(spawnOptions.cwd).toBe(options.cwd);
    expect(spawnOptions.shell).toBeUndefined();
    expect(spawnOptions.env.DISPLAY).toBe(":91");
    expect(spawnOptions.env.PATH).toBe(
      path.join(root, "usr/bin") + path.delimiter + "preserved-path",
    );
    expect(spawnOptions.env.LD_LIBRARY_PATH).toBe(path.join(root, "usr/lib"));
    expect(spawnOptions.env.MONO_CFG_DIR).toBe(path.join(root, "etc/mono"));
    expect(spawnOptions.env.MONO_GAC_PREFIX).toBe(path.join(root, "usr"));
    expect(spawnOptions.env.MONO_PATH).toBe(
      [path.join(root, "usr/lib/mono/4.5"), path.join(root, "usr/lib/mono/4.5/Facades")].join(
        path.delimiter,
      ),
    );
    expect(spawnOptions.env.MONO_ENV_OPTIONS).toBeUndefined();
    expect(spawnOptions.env.DOTNET_ROOT).toBeUndefined();
    expect(spawnOptions.env.LD_PRELOAD).toBeUndefined();
    expect(options.env.MONO_ENV_OPTIONS).toBe("--wrong");
    await launcher.cleanup();
  });
  it("refuses an unexpected executable before spawning anything", async () => {
    await expect(
      new NativeProcessLauncher(runtime).launch(path.join(root, "other.exe"), [], options),
    ).rejects.toThrow("unexpected helper");
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});
