import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@nexusmods/fomod-installer-ipc", () => ({
  SecurityLevel: { Regular: "regular", Sandbox: "sandbox" },
}));
const mocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  strategies: vi.fn(),
  dispose: vi.fn(),
  runtime: vi.fn(),
}));
vi.mock("./utils/BundledRuntime", () => ({ prepareNativeRuntime: mocks.runtime }));
vi.mock("../../util/getVortexPath", () => ({ default: () => "/unused" }));
vi.mock("./utils/connectionStrategy", () => ({ createConnectionStrategies: mocks.strategies }));
vi.mock("./utils/VortexIPCConnection", () => ({
  VortexIPCConnection: class {
    initialize = mocks.initialize;
    dispose = mocks.dispose;
  },
}));
vi.mock("../installer_fomod_shared/delegates/SharedDelegates", () => ({ SharedDelegates: {} }));
vi.mock("./delegates/CSharpDelegates", () => ({ CSharpDelegates: class {} }));
vi.mock("../gamemode_management/util/getGame", () => ({ getGame: vi.fn() }));
vi.mock("../installer_fomod_shared/utils/gameSupport", () => ({
  getPluginPath: vi.fn(),
  getStopPatterns: vi.fn(),
  uniPatterns: [],
}));
vi.mock("../../util/log", () => ({ log: vi.fn() }));
import type { IExtensionApi } from "../../types/api";
import { UserCanceled } from "../../util/CustomErrors";
import { install } from "./installer";

const boundary = new Error("Inert helper boundary reached");
function setup(action?: string, noDialog = false) {
  const showDialog = vi.fn(async () =>
    action === "approve"
      ? { action: "translated:Install anyway (unsafe)" }
      : action === undefined
        ? undefined
        : { action },
  );
  const deployment = vi.fn();
  const dotnet = vi.fn();
  const api = {
    translate: (key: string) => "translated:" + key,
    showDialog: noDialog ? undefined : showDialog,
    ext: { awaitNextPhaseDeployment: deployment, awaitDotnetAssert: dotnet },
    getState: () => ({ settings: { mods: { installerSandbox: true } } }),
  } as unknown as IExtensionApi;
  return { api, showDialog, deployment, dotnet };
}
const run = (api: IExtensionApi, game = "skyrim", details?: Parameters<typeof install>[7]) =>
  install(
    api,
    ["Wrapper\\FoMoD\\SCRIPT.CS"],
    "/unused/staging",
    game,
    undefined,
    false,
    "/unused/mod.7z",
    details,
  );

beforeEach(() => {
  vi.clearAllMocks();
  mocks.initialize.mockRejectedValue(boundary);
  mocks.runtime.mockResolvedValue({
    root: "/unused/runtime",
    helper: "/unused/runtime/helper/ModInstallerIPC.exe",
  });
});
describe("C# execution trust boundary", () => {
  it.each([undefined, "translated:Cancel installation", "", "unexpected action"])(
    "refuses non-affirmative response %j before any runtime or deployment",
    async (action) => {
      const ctx = setup(action);
      await expect(run(ctx.api)).rejects.toBeInstanceOf(UserCanceled);
      expect(ctx.showDialog).toHaveBeenCalledOnce();
      expect(ctx.deployment).not.toHaveBeenCalled();
      expect(ctx.dotnet).not.toHaveBeenCalled();
      expect(mocks.runtime).not.toHaveBeenCalled();
      expect(mocks.strategies).not.toHaveBeenCalled();
      expect(mocks.initialize).not.toHaveBeenCalled();
    },
  );
  it("fails closed when the caller has no dialog capability", async () => {
    const ctx = setup(undefined, true);
    await expect(run(ctx.api)).rejects.toBeInstanceOf(UserCanceled);
    expect(mocks.initialize).not.toHaveBeenCalled();
  });
  it("requires approval even when simulation supplies null details", async () => {
    const ctx = setup();
    await expect(run(ctx.api, "skyrim", null)).rejects.toBeInstanceOf(UserCanceled);
    expect(mocks.initialize).not.toHaveBeenCalled();
  });
  it("does not let saved unattended choices bypass consent", async () => {
    const ctx = setup();
    await expect(
      install(
        ctx.api,
        ["fomod/script.cs"],
        "/unused/staging",
        "skyrim",
        { type: "fomod", options: {} },
        true,
        "/unused/mod.7z",
      ),
    ).rejects.toBeInstanceOf(UserCanceled);
    expect(ctx.deployment).not.toHaveBeenCalled();
    expect(ctx.dotnet).not.toHaveBeenCalled();
    expect(mocks.runtime).not.toHaveBeenCalled();
    expect(mocks.initialize).not.toHaveBeenCalled();
  });
  it("does not start a helper if the consent dialog fails", async () => {
    const ctx = setup();
    const failure = new Error("Dialog unavailable");
    ctx.showDialog.mockRejectedValueOnce(failure);
    await expect(run(ctx.api)).rejects.toBe(failure);
    expect(ctx.deployment).not.toHaveBeenCalled();
    expect(ctx.dotnet).not.toHaveBeenCalled();
    expect(mocks.runtime).not.toHaveBeenCalled();
    expect(mocks.initialize).not.toHaveBeenCalled();
  });
  it("starts the existing runtime route only after explicit approval", async () => {
    const ctx = setup("approve");
    await expect(run(ctx.api)).rejects.toBe(boundary);
    expect(ctx.showDialog).toHaveBeenCalledOnce();
    expect(ctx.deployment).toHaveBeenCalledOnce();
    expect(ctx.dotnet).toHaveBeenCalledTimes(process.platform === "linux" ? 0 : 1);
    expect(mocks.runtime).toHaveBeenCalledTimes(process.platform === "linux" ? 1 : 0);
    expect(mocks.initialize).toHaveBeenCalledOnce();
    expect(mocks.dispose).toHaveBeenCalledOnce();
    expect(ctx.showDialog.mock.invocationCallOrder[0]).toBeLessThan(
      ctx.deployment.mock.invocationCallOrder[0],
    );
  });
  it("preserves the existing per-game mod allowlist", async () => {
    const ctx = setup();
    await expect(
      run(ctx.api, "falloutnv", {
        modReference: { repo: { repository: "nexus", fileId: "1", modId: "42507" } },
      }),
    ).rejects.toBe(boundary);
    expect(ctx.showDialog).not.toHaveBeenCalled();
    expect(mocks.initialize).toHaveBeenCalledOnce();
  });
  it("does not borrow another game's allowlisted mod ID", async () => {
    const ctx = setup();
    await expect(
      run(ctx.api, "skyrim", {
        modReference: { repo: { repository: "nexus", fileId: "1", modId: "42507" } },
      }),
    ).rejects.toBeInstanceOf(UserCanceled);
    expect(mocks.initialize).not.toHaveBeenCalled();
  });
  it("sandbox trust metadata does not replace explicit script approval", async () => {
    const ctx = setup();
    await expect(run(ctx.api, "skyrim", { isTrusted: true })).rejects.toBeInstanceOf(UserCanceled);
    expect(mocks.initialize).not.toHaveBeenCalled();
  });
});
