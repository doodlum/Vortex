import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@nexusmods/fomod-installer-ipc", () => ({
  SecurityLevel: { Sandbox: "sandbox", Regular: "regular" },
  NamedPipeTransport: class {
    type = "pipe";
  },
  TCPTransport: class {
    type = "tcp";
  },
  SandboxProcessLauncher: class {
    getSecurityLevel() {
      return "sandbox";
    }
  },
  RegularProcessLauncher: class {
    getSecurityLevel() {
      return "regular";
    }
  },
}));

import { SecurityLevel } from "@nexusmods/fomod-installer-ipc";

import { createConnectionStrategies } from "./connectionStrategy";
import { NativeProcessLauncher } from "./NativeProcessLauncher";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
});
const runtime = {
  root: "/private",
  mono: "/private/usr/bin/mono-sgen",
  helper: "/private/helper/ModInstallerIPC.exe",
  config: "/private/etc/mono/config",
};

describe("legacy C# connection platform routing", () => {
  it("uses only native Mono and TCP on Linux, without claiming AppContainer", () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const strategies = createConnectionStrategies({
      securityLevel: SecurityLevel.Sandbox,
      nativeRuntime: runtime,
    });
    expect(strategies).toHaveLength(1);
    expect(strategies[0].transport.type).toBe("tcp");
    expect(strategies[0].launcher).toBeInstanceOf(NativeProcessLauncher);
    expect(strategies[0].launcher.getSecurityLevel()).toBe(SecurityLevel.Regular);
  });
  it("does not fall through to a system runtime or Windows helper if Linux setup is missing", () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    expect(() => createConnectionStrategies({ allowFallback: true })).toThrow("not been prepared");
  });
  it("preserves the Windows sandbox and both existing fallback transports", () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const strategies = createConnectionStrategies({ nativeRuntime: runtime });
    expect(
      strategies.map((item) => [item.transport.type, item.launcher.getSecurityLevel()]),
    ).toEqual([
      ["pipe", SecurityLevel.Sandbox],
      ["pipe", SecurityLevel.Regular],
      ["tcp", SecurityLevel.Regular],
    ]);
    expect(strategies.every((item) => !(item.launcher instanceof NativeProcessLauncher))).toBe(
      true,
    );
  });
  it("preserves Windows fallback disabling", () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const sandbox = createConnectionStrategies({
      securityLevel: SecurityLevel.Sandbox,
      allowFallback: false,
    });
    const regular = createConnectionStrategies({
      securityLevel: SecurityLevel.Regular,
      allowFallback: false,
    });
    expect(sandbox.map((item) => [item.transport.type, item.launcher.getSecurityLevel()])).toEqual([
      ["pipe", SecurityLevel.Sandbox],
    ]);
    expect(regular.map((item) => [item.transport.type, item.launcher.getSecurityLevel()])).toEqual([
      ["pipe", SecurityLevel.Regular],
    ]);
  });
});
