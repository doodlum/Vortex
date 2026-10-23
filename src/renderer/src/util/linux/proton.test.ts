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
  resolveProtonPath,
  findLatestProton,
  getProtonInfo,
  buildProtonEnvironment,
  getSteamLibraryPaths,
  inheritedProtonTuning,
  prefixDowngradeWarning,
  steamProtonLabel,
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
    await fs.writeFile(
      path.join(custom, "compatibilitytool.vdf"),
      '"compatibilitytools" { "compat_tools" { "Exact-GE-Key" { "install_path" "." "from_oslist" "windows" "to_oslist" "linux" } } }',
    );

    const tools = await listInstalledProton(steamPath);

    expect(protonConfigName(tools.find((tool) => tool.source === "custom")!)).toBe("Exact-GE-Key");
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
      protonConfigName({
        id: "three",
        name: "GE-Proton11-3",
        path: "three",
        source: "custom",
        compatibilityName: "GE-Proton11-3",
      }),
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
      ].map(async (name) => {
        await fs.mkdir(path.join(common, name), { recursive: true });
        await fs.writeFile(path.join(common, name, "proton"), "");
      }),
    );

    await expect(findLatestStableProtonName(steamPath)).resolves.toBe("proton_11");
  });

  it("scans remaining libraries when the first is missing and retains the Experimental path", async () => {
    const library = await temporaryDirectory();
    const experimental = path.join(library, "steamapps", "common", "Proton - Experimental");
    await fs.mkdir(experimental, { recursive: true });
    await fs.writeFile(path.join(experimental, "proton"), "");
    await expect(findLatestProton([path.join(library, "missing"), library])).resolves.toBe(
      experimental,
    );
    await expect(findLatestProton([library, path.join(library, "missing")])).resolves.toBe(
      experimental,
    );
  });

  it("handles absent default configuration and selects numeric versions", async () => {
    const steam = await temporaryDirectory();
    for (const version of ["9.0", "10.0", "19.0"]) {
      const folder = path.join(steam, "steamapps", "common", `Proton ${version}`);
      await fs.mkdir(folder, { recursive: true });
      await fs.writeFile(path.join(folder, "proton"), "");
    }
    await fs.mkdir(path.join(steam, "steamapps", "compatdata", "413150", "pfx"), {
      recursive: true,
    });
    await expect(resolveProtonPath(steam, [steam], undefined)).resolves.toBeUndefined();
    await expect(resolveProtonPath(steam, [steam], "proton_9")).resolves.toBe(
      path.join(steam, "steamapps", "common", "Proton 9.0"),
    );
    await expect(
      getProtonInfo(steam, [steam], path.join(steam, "steamapps"), "413150"),
    ).resolves.toMatchObject({
      usesProton: true,
      protonPath: path.join(steam, "steamapps", "common", "Proton 19.0"),
    });
  });

  it("preserves the caller environment without injecting incompatible overlay libraries", () => {
    expect(
      buildProtonEnvironment({
        compatDataPath: "/prefix",
        steamPath: "/steam",
        appId: "413150",
        existingEnv: { LD_PRELOAD: "/custom.so", CUSTOM: "value" },
      }),
    ).toMatchObject({
      LD_PRELOAD: "/custom.so",
      CUSTOM: "value",
      WINEPREFIX: path.join("/prefix", "pfx"),
    });
    expect(
      buildProtonEnvironment({ compatDataPath: "/prefix", steamPath: "/steam", appId: "413150" }),
    ).not.toHaveProperty("LD_PRELOAD");
  });

  it("discovers a configured secondary library without requiring contiguous indexes", async () => {
    const steam = await temporaryDirectory();
    const extra = await temporaryDirectory();
    await fs.mkdir(path.join(steam, "config"));
    await fs.writeFile(
      path.join(steam, "config", "libraryfolders.vdf"),
      `"libraryfolders" { "7" { "path" "${extra.replaceAll("\\", "/")}" } }`,
    );
    await expect(getSteamLibraryPaths(steam)).resolves.toEqual([steam, extra]);
  });

  it("recognises an explicitly configured Windows game before the first prefix creation", async () => {
    const steam = await temporaryDirectory();
    await fs.mkdir(path.join(steam, "config"));
    await fs.writeFile(
      path.join(steam, "config", "config.vdf"),
      '"InstallConfigStore" { "Software" { "Valve" { "Steam" { "CompatToolMapping" { "413150" { "name" "proton_10" } } } } } }',
    );
    await expect(
      getProtonInfo(steam, [steam], path.join(steam, "steamapps"), "413150"),
    ).resolves.toMatchObject({ usesProton: true, protonPath: undefined });
    await expect(
      getProtonInfo(steam, [steam], path.join(steam, "steamapps"), "999"),
    ).resolves.toEqual({ usesProton: false });
  });

  it("does not assign Proton to a native Steam compatibility tool with an old prefix", async () => {
    const steam = await temporaryDirectory();
    await fs.mkdir(path.join(steam, "config"));
    await fs.mkdir(path.join(steam, "steamapps", "compatdata", "413150", "pfx"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(steam, "config", "config.vdf"),
      '"InstallConfigStore" { "Software" { "Valve" { "Steam" { "CompatToolMapping" { "413150" { "name" "SteamLinuxRuntime_sniper" } } } } } }',
    );
    await expect(
      getProtonInfo(steam, [steam], path.join(steam, "steamapps"), "413150"),
    ).resolves.toEqual({ usesProton: false });
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

  it("finds hints beyond the first megabyte within the bounded eight-megabyte scan", async () => {
    const gamePath = await temporaryDirectory();
    await fs.writeFile(
      path.join(gamePath, "large.dll"),
      Buffer.concat([Buffer.alloc(2 * 1024 * 1024), Buffer.from("D3DCOMPILER_47.dll")]),
    );
    await expect(detectRuntimeDependencies(gamePath)).resolves.toEqual(["d3dcompiler_47"]);
  });
});

it("sets the selected game's app identity and matching SDK home only in the Proton child", () => {
  const originalHome = process.env.HOME;
  const env = buildProtonEnvironment({
    compatDataPath: "/prefix",
    steamPath: "/steam",
    appId: "413150",
    steamHome: "/steam-snap-home",
  });
  expect(env).toMatchObject({
    HOME: "/steam-snap-home",
    SteamAppId: "413150",
    SteamGameId: "413150",
  });
  expect(env).not.toHaveProperty("PROTON_LOG");
  expect(process.env.HOME).toBe(originalHome);
});

it("preserves an explicit caller home while keeping identity consistent with the selected prefix", () => {
  const env = buildProtonEnvironment({
    compatDataPath: "/prefix",
    steamPath: "/steam",
    appId: "413150",
    steamHome: "/steam-snap-home",
    existingEnv: { HOME: "/explicit-home", SteamAppId: "other", SteamGameId: "other" },
  });
  expect(env).toMatchObject({
    HOME: "/explicit-home",
    SteamAppId: "413150",
    SteamGameId: "413150",
  });
  expect(
    buildProtonEnvironment({ compatDataPath: "/prefix", steamPath: "/steam", appId: "413150" }),
  ).not.toHaveProperty("HOME");
});

describe("prefixDowngradeWarning", () => {
  const script = (version: string) =>
    `#!/usr/bin/env python3\nCURRENT_PREFIX_VERSION="${version}"\n`;

  it("explains an older stock Proton driving a prefix a newer one built", () => {
    expect(prefixDowngradeWarning(script("9.0-203"), "10.0-100\n")).toMatch(
      /created by Proton 10 \(10\.0-100\).*Proton 9 \(9\.0-203\)/,
    );
    expect(prefixDowngradeWarning(script("10.0-100"), "10.1000-200")).toContain("Proton 10");
  });

  it("allows equal or newer runtimes, GE builds and unreadable inputs", () => {
    expect(prefixDowngradeWarning(script("10.0-100"), "10.0-100")).toBeUndefined();
    expect(prefixDowngradeWarning(script("10.0-100"), "9.0-203")).toBeUndefined();
    expect(prefixDowngradeWarning(script("GE-Proton10-33"), "10.0-100")).toBeUndefined();
    expect(prefixDowngradeWarning(script("9.0-203"), "GE-Proton10-33")).toBeUndefined();
    expect(prefixDowngradeWarning("", "10.0-100")).toBeUndefined();
    expect(prefixDowngradeWarning(script("9.0-203"), "")).toBeUndefined();
  });
});

describe("inheritedProtonTuning", () => {
  it("keeps tuning variables and drops identity, path and unrelated variables", () => {
    expect(
      inheritedProtonTuning({
        PROTON_LOG: "1",
        DXVK_HUD: "fps",
        VKD3D_CONFIG: "dxr",
        WINEDEBUG: "-all",
        SteamDeck: "0",
        __GL_SHADER_DISK_CACHE: "1",
        WINEPREFIX: "/elsewhere",
        STEAM_COMPAT_DATA_PATH: "/elsewhere",
        SteamAppId: "999",
        PATH: "/app/bin",
        UNSET: undefined,
      }),
    ).toEqual({
      PROTON_LOG: "1",
      DXVK_HUD: "fps",
      VKD3D_CONFIG: "dxr",
      WINEDEBUG: "-all",
      SteamDeck: "0",
      __GL_SHADER_DISK_CACHE: "1",
    });
  });
});

describe("Steam's Proton for a game", () => {
  it("follows the Proton that last ran the prefix before Steam's default and the newest", async () => {
    const steam = await temporaryDirectory();
    const common = path.join(steam, "steamapps", "common");
    for (const name of ["Proton 9.0", "Proton - Experimental"]) {
      await fs.mkdir(path.join(common, name), { recursive: true });
      await fs.writeFile(path.join(common, name, "proton"), "");
    }
    const compatData = path.join(steam, "steamapps", "compatdata", "42");
    await fs.mkdir(path.join(compatData, "pfx"), { recursive: true });
    const info = () => getProtonInfo(steam, [steam], path.join(steam, "steamapps"), "42");

    expect((await info()).protonPath).toBe(path.join(common, "Proton - Experimental"));
    // Steam records the runtime it used in the prefix, through whichever path it was started.
    await fs.writeFile(
      path.join(compatData, "config_info"),
      "5\n/home/user/.steam/steam/steamapps/common/Proton 9.0/files/share/fonts/\n",
    );
    expect((await info()).protonPath).toBe(path.join(common, "Proton 9.0"));
  });
});

describe("steamProtonLabel", () => {
  it("names Valve's tools as Steam shows them and keeps custom tools' own names", () => {
    expect(steamProtonLabel("proton_9")).toBe("Proton 9");
    expect(steamProtonLabel("proton_experimental")).toBe("Proton Experimental");
    expect(steamProtonLabel("proton_hotfix")).toBe("Proton Hotfix");
    expect(steamProtonLabel("GE-Proton10-4")).toBe("GE-Proton10-4");
  });
});
