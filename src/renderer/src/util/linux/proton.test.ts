import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { afterEach, describe, expect, it } from "vitest";

import {
  detectRuntimeDependencies,
  findLatestStableProtonName,
  inspectPrefix,
  listInstalledProton,
  protonConfigName,
} from "./proton";

const temporaryPaths: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const result = await fs.mkdtemp(path.join(os.tmpdir(), "vortex-proton-test-"));
  temporaryPaths.push(result);
  return result;
}

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((entry) => fs.rm(entry, { force: true, recursive: true })),
  );
});

describe("Proton management", () => {
  it("discovers official and custom Proton installations by capability", async () => {
    const steamPath = await temporaryDirectory();
    const official = path.join(steamPath, "steamapps", "common", "Proton 11.0");
    const custom = path.join(steamPath, "compatibilitytools.d", "GE-Proton11-3");
    await fs.mkdir(official, { recursive: true });
    await fs.mkdir(custom, { recursive: true });
    await fs.writeFile(path.join(official, "proton"), "");
    await fs.writeFile(path.join(custom, "proton"), "");

    const tools = await listInstalledProton(steamPath);

    expect(tools.map((tool) => [tool.name, tool.source])).toEqual([
      ["GE-Proton11-3", "custom"],
      ["Proton 11.0", "steam"],
    ]);
  });

  it("maps installed tools to the compatibility names Steam uses", () => {
    expect(protonConfigName({ id: "one", name: "Proton 11.0", path: "one", source: "steam" })).toBe(
      "proton_11",
    );
    expect(
      protonConfigName({
        id: "two",
        name: "Proton - Experimental",
        path: "two",
        source: "steam",
      }),
    ).toBe("proton_experimental");
    expect(
      protonConfigName({ id: "three", name: "GE-Proton11-3", path: "three", source: "custom" }),
    ).toBe("GE-Proton11-3");
  });

  it("defaults to the newest installed official stable Proton", async () => {
    const steamPath = await temporaryDirectory();
    const common = path.join(steamPath, "steamapps", "common");
    await Promise.all(
      [
        "Proton 9.0 (Beta)",
        "Proton - Experimental",
        "Proton Hotfix",
        "Proton 9.0",
        "Proton 11.0",
      ].map((name) => fs.mkdir(path.join(common, name), { recursive: true })),
    );

    await expect(findLatestStableProtonName(steamPath)).resolves.toBe("proton_11");
  });

  it("reads unique installed winetricks components from the selected prefix", async () => {
    const compatDataPath = await temporaryDirectory();
    await fs.mkdir(path.join(compatDataPath, "pfx"));
    await fs.writeFile(
      path.join(compatDataPath, "pfx", "winetricks.log"),
      "vcrun2022\ndxvk\nvcrun2022\n",
    );

    const inventory = await inspectPrefix(compatDataPath);

    expect(inventory.winetricks).toEqual(["vcrun2022", "dxvk"]);
    expect(inventory.components).toEqual(["dxvk", "vcrun2022"]);
  });

  it("recognises runtime capabilities even when winetricks did not install them", async () => {
    const compatDataPath = await temporaryDirectory();
    const system32 = path.join(compatDataPath, "pfx", "drive_c", "windows", "system32");
    await fs.mkdir(system32, { recursive: true });
    await fs.writeFile(path.join(system32, "vcruntime140.dll"), "");
    await fs.writeFile(path.join(system32, "msvcp140.dll"), "");

    const inventory = await inspectPrefix(compatDataPath);

    expect(inventory.components).toContain("vcrun2022");
    expect(inventory.winetricks).not.toContain("vcrun2022");
  });

  it("infers redistributables from executable imports without a game-specific rule", async () => {
    const gamePath = await temporaryDirectory();
    await fs.writeFile(
      path.join(gamePath, "tool.dll"),
      Buffer.from("header VCRUNTIME140.dll MSVCP140_1.dll XINPUT1_3.dll footer"),
    );

    await expect(detectRuntimeDependencies(gamePath)).resolves.toEqual(["vcrun2022", "xinput"]);
  });
});
