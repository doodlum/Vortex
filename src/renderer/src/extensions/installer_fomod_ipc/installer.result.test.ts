import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ install: vi.fn(), dispose: vi.fn() }));
vi.mock("@nexusmods/fomod-installer-ipc", () => ({
  SecurityLevel: { Regular: "regular", Sandbox: "sandbox" },
}));
vi.mock("./utils/confirmScriptTrust", () => ({ confirmScriptTrust: vi.fn() }));
vi.mock("./utils/BundledRuntime", () => ({
  prepareNativeRuntime: vi.fn(async () => ({ helper: "/unused/helper.exe" })),
}));
vi.mock("./utils/connectionStrategy", () => ({ createConnectionStrategies: vi.fn(() => []) }));
vi.mock("./utils/VortexIPCConnection", () => ({
  VortexIPCConnection: class {
    initialize = vi.fn();
    registerCallback = vi.fn();
    install = mocks.install;
    dispose = mocks.dispose;
  },
}));
vi.mock("../../util/getVortexPath", () => ({ default: () => "/unused" }));
vi.mock("../../util/log", () => ({ log: vi.fn() }));
vi.mock("../gamemode_management/util/getGame", () => ({ getGame: vi.fn() }));
vi.mock("../installer_fomod_shared/delegates/SharedDelegates", () => ({
  SharedDelegates: { create: vi.fn(async () => ({})) },
}));
vi.mock("./delegates/CSharpDelegates", () => ({ CSharpDelegates: class {} }));
vi.mock("../installer_fomod_shared/utils/gameSupport", () => ({
  getPluginPath: vi.fn(),
  getStopPatterns: vi.fn(() => []),
  uniPatterns: [],
}));

import type { IExtensionApi, IInstallResult } from "../../types/api";
import { UserCanceled } from "../../util/CustomErrors";
import { install } from "./installer";

const api = {
  getState: () => ({ settings: { mods: { installerSandbox: false } } }),
  ext: {},
} as unknown as IExtensionApi;
const run = (files = ["Wrapper\\FoMoD\\SCRIPT.CS"]) =>
  install(api, files, "/unused/staged", "fallout3", undefined, false, "/unused/mod.zip");
const warning = () => ({
  type: "error",
  source: "Installer failed (it should have reported an error message)",
  value: "warning",
  destination: null,
});
beforeEach(() => vi.clearAllMocks());

describe("legacy C# installer result boundaries", () => {
  it("makes the helper's error-only failure fatal before installer metadata is appended", async () => {
    mocks.install.mockResolvedValue({ instructions: [warning()] });
    const result = await run();
    expect(result.instructions[0]).toMatchObject({
      type: "error",
      value: "fatal",
      source: warning().source,
    });
    expect(result.instructions).toContainEqual(
      expect.objectContaining({ type: "attribute", key: "installerChoices" }),
    );
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });
  it("preserves every diagnostic when a failed C# result contains only errors", async () => {
    mocks.install.mockResolvedValue({
      instructions: [warning(), { ...warning(), source: "Second diagnostic", value: "fatal" }],
    });
    const result = await run();
    expect(result.instructions.slice(0, 2)).toEqual([
      expect.objectContaining({ source: warning().source, value: "fatal" }),
      expect.objectContaining({ source: "Second diagnostic", value: "fatal" }),
    ]);
  });
  it.each([
    { type: "copy", source: "payload.txt", destination: "payload.txt" },
    { type: "iniedit", destination: "settings.ini", section: "General", key: "Value", value: "1" },
  ])(
    "keeps C# warnings nonfatal when a real output instruction is present: $type",
    async (output) => {
      mocks.install.mockResolvedValue({ instructions: [warning(), output] });
      const result = await run();
      expect(result.instructions[0]).toMatchObject({ value: "warning" });
      expect(result.instructions[1]).toEqual(output);
    },
  );
  it("keeps XML warning handling unchanged", async () => {
    mocks.install.mockResolvedValue({ instructions: [warning()] });
    const result = await run(["fomod/ModuleConfig.xml"]);
    expect(result.instructions[0]).toMatchObject({ value: "warning" });
  });
  it("preserves a successful C# copy", async () => {
    const copy = { type: "copy", source: "payload.txt", destination: "payload.txt" };
    mocks.install.mockResolvedValue({ instructions: [copy] });
    const result = await run();
    expect(result.instructions[0]).toEqual(copy);
  });
  it.each([null, { instructions: null }])(
    "retains a helper cancellation signal %j",
    async (result) => {
      mocks.install.mockResolvedValue(result as unknown as IInstallResult);
      await expect(run()).rejects.toBeInstanceOf(UserCanceled);
      expect(mocks.dispose).toHaveBeenCalledOnce();
    },
  );
});
