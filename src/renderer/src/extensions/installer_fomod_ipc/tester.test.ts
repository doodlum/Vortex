import { describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ initialize: vi.fn() }));
vi.mock("./utils/connectionStrategy", () => ({ createConnectionStrategies: () => [] }));
vi.mock("./utils/VortexIPCConnection", () => ({
  VortexIPCConnection: class {
    initialize = runtime.initialize;
    dispose = vi.fn();
  },
}));
vi.mock("../../util/log", () => ({ log: vi.fn() }));

import type { IExtensionApi } from "../../types/api";
import { testSupported } from "./tester";

const api = {} as IExtensionApi;

describe("legacy C# installer discovery", () => {
  it.each(["fallout3", "falloutnv", "oblivion"])(
    "recognizes %s from archive metadata without launching a runtime",
    async (game) => {
      const files = ["Wrapper\\FoMoD\\SCRIPT.CS", "Wrapper\\Image.PNG", "Wrapper\\mod.esp"];
      const result = await testSupported(api, files, game);
      expect(result).toEqual({ supported: true, requiredFiles: files });
      expect(runtime.initialize).not.toHaveBeenCalled();
    },
  );

  it.each(["skyrim", "skyrimspecialedition", "fallout4"])(
    "leaves %s to the other installers, as upstream does",
    async (game) => {
      expect(await testSupported(api, ["fomod/script.cs"], game)).toEqual({
        supported: false,
        requiredFiles: [],
      });
    },
  );

  it("retains every archive member because scripts can read arbitrary package assets", async () => {
    const files = ["fomod/script.cs", "Images/Choice.PNG", "optional/a.esp", "optional/b.esp"];
    expect((await testSupported(api, files, "oblivion")).requiredFiles).toEqual(files);
    expect(files).toEqual([
      "fomod/script.cs",
      "Images/Choice.PNG",
      "optional/a.esp",
      "optional/b.esp",
    ]);
  });

  it("honors an explicit no-C# archive classification", async () => {
    expect(
      await testSupported(api, ["fomod/script.cs"], "fallout3", { hasCSScripts: false }),
    ).toEqual({ supported: false, requiredFiles: [] });
  });

  it.each([
    ["fomod/script.cs\n"],
    ["fomod/script.cs\r\n"],
    ["script.cs"],
    ["source/script.cs"],
    ["fomod/old installer/script.cs"],
    ["fomod/script.cs.bak"],
    ["fomod/ModuleConfig.xml"],
    ["../fomod/script.cs"],
    ["/fomod/script.cs"],
    ["C:\\fomod\\script.cs"],
    ["fomod/script.cs", "../outside.txt"],
  ])("does not claim unrelated or unsafe entries %j", async (...files) => {
    expect(await testSupported(api, files, "fallout3")).toEqual({
      supported: false,
      requiredFiles: [],
    });
  });
});
