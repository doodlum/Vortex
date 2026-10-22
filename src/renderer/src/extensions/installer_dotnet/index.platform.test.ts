import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn() }));
vi.mock("child_process", () => ({
  spawn: mocks.spawn,
  execFile: mocks.execFile,
  default: { spawn: mocks.spawn, execFile: mocks.execFile },
}));
vi.mock("../../util/api", () => ({
  getVortexPath: () => "/unused/assets",
  UserCanceled: class extends Error {},
}));
vi.mock("../../util/log", () => ({ log: vi.fn() }));
vi.mock("../../util/util", () => ({ delayed: vi.fn(), toPromise: vi.fn() }));
vi.mock("../download_management/selectors", () => ({ downloadPathForGame: vi.fn() }));
vi.mock("../gamemode_management/constants", () => ({ SITE_ID: "site" }));

import type { IExtensionContext } from "../../types/api";
import type initializeDotnet from "./index";

const platform = Object.getOwnPropertyDescriptor(process, "platform");
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
});
function context() {
  const api = { ext: {} as Record<string, () => PromiseLike<void>> };
  const registerTest = vi.fn();
  const once = vi.fn((callback: () => void) => callback());
  return { api, registerTest, once };
}

describe("Desktop Runtime platform boundary", () => {
  it("does not register a Windows Desktop Runtime check on Linux", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const { default: main } = await vi.importActual<{ default: typeof initializeDotnet }>(
      "./index",
    );
    const ctx = context();
    expect(main(ctx as unknown as IExtensionContext)).toBe(true);
    expect(ctx.registerTest).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.execFile).not.toHaveBeenCalled();
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Runtime assertion did not settle")), 250),
    );
    await expect(Promise.race([ctx.api.ext.awaitDotnetAssert(), timeout])).resolves.toBeUndefined();
  });
  it("retains the Windows startup probe and resolved public assertion", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    mocks.execFile.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
      });
      queueMicrotask(() => child.emit("close", 0));
      return child;
    });
    const { default: main } = await vi.importActual<{ default: typeof initializeDotnet }>(
      "./index",
    );
    const ctx = context();
    expect(main(ctx as unknown as IExtensionContext)).toBe(true);
    expect(ctx.registerTest).toHaveBeenCalledOnce();
    const [name, phase, check] = ctx.registerTest.mock.calls[0];
    expect([name, phase]).toEqual(["dotnet-installed", "startup"]);
    expect(mocks.spawn).not.toHaveBeenCalled();
    await expect(check()).resolves.toBeUndefined();
    expect(mocks.execFile).toHaveBeenCalledWith(expect.stringMatching(/dotnetprobe\.exe$/), ["9"]);
    await expect(ctx.api.ext.awaitDotnetAssert()).resolves.toBeUndefined();
  });
});
