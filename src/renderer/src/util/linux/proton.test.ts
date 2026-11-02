import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  detectRuntimeDependencies,
  findLatestStableProtonName,
  inspectPrefix,
  listInstalledProton,
  protonConfigName,
  resolveProtonPath,
  resolveSteamProton,
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
  const result = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "vortex-proton-test-")));
  temporaryPaths.push(result);
  return result;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryPaths.splice(0).map((entry) => fs.rm(entry, { force: true, recursive: true })),
  );
});

let registeredId = 1000;
async function officialTool(
  steam: string,
  name: string,
  folder = name,
  appId = String(++registeredId),
  lastUpdated = "1",
) {
  const install = path.join(steam, "steamapps", "common", folder);
  await fs.mkdir(install, { recursive: true });
  await fs.writeFile(path.join(install, "proton"), "");
  await fs.writeFile(
    path.join(steam, "steamapps", `appmanifest_${appId}.acf`),
    `"AppState" { "appid" "${appId}" "name" "${name}" "installdir" "${folder}" "LastUpdated" "${lastUpdated}" }`,
  );
  return fs.realpath(install);
}

describe("Proton management", () => {
  async function customTool(root: string, key: string, installPath: string) {
    await fs.mkdir(path.dirname(root), { recursive: true });
    await fs.mkdir(installPath, { recursive: true });
    await fs.writeFile(path.join(installPath, "proton"), "");
    await fs.writeFile(
      root,
      `"compatibilitytools" { "compat_tools" { "${key}" { "install_path" "${installPath.replaceAll("\\", "\\\\")}" "from_oslist" "windows" "to_oslist" "linux" } } }`,
    );
  }

  it("discovers a standalone custom manifest targeting an external installation", async () => {
    const steam = await temporaryDirectory();
    const tool = await temporaryDirectory();
    await customTool(
      path.join(steam, "compatibilitytools.d", "external.vdf"),
      "External-Key",
      tool,
    );
    const found = (await listInstalledProton(steam)).find(
      (entry) => protonConfigName(entry) === "External-Key",
    );
    expect(found).toMatchObject({ path: await fs.realpath(tool), source: "custom" });
    await expect(resolveProtonPath(steam, [steam], "External-Key")).resolves.toBe(
      await fs.realpath(tool),
    );
  });

  it("discovers extra compatibility-tool roots once and uses their internal names", async () => {
    const steam = await temporaryDirectory();
    const extra = await temporaryDirectory();
    const tool = path.join(extra, "Different-Folder");
    await customTool(path.join(tool, "compatibilitytool.vdf"), "Exact-Extra-Key", tool);
    vi.stubEnv("STEAM_EXTRA_COMPAT_TOOLS_PATHS", [extra, extra].join(path.delimiter));
    const found = (await listInstalledProton(steam)).filter(
      (entry) => protonConfigName(entry) === "Exact-Extra-Key",
    );
    expect(found).toHaveLength(1);
    expect(found[0].path).toBe(await fs.realpath(tool));
    await expect(resolveProtonPath(steam, [steam], "Exact-Extra-Key")).resolves.toBe(
      await fs.realpath(tool),
    );
  });

  it("keeps valid standalone tools discoverable beside a malformed manifest", async () => {
    const steam = await temporaryDirectory();
    const tool = await temporaryDirectory();
    const root = path.join(steam, "compatibilitytools.d");
    await customTool(path.join(root, "z-valid.vdf"), "Valid-Key", tool);
    await fs.writeFile(path.join(root, "a-malformed.vdf"), "not a valid manifest");
    expect((await listInstalledProton(steam)).map(protonConfigName)).toContain("Valid-Key");
  });

  it("refuses different custom installations with the same configured internal name", async () => {
    const steam = await temporaryDirectory();
    for (const folder of ["one", "two"]) {
      const tool = path.join(steam, "compatibilitytools.d", folder);
      await customTool(path.join(tool, "compatibilitytool.vdf"), "Duplicate-Key", tool);
    }
    await expect(resolveProtonPath(steam, [steam], "Duplicate-Key")).rejects.toThrow(
      /Duplicate-Key.*multiple installations/,
    );
  });

  it("never resolves a custom installation by its folder instead of its internal key", async () => {
    const steam = await temporaryDirectory();
    const tool = path.join(steam, "compatibilitytools.d", "Missing-Key");
    await customTool(path.join(tool, "compatibilitytool.vdf"), "Different-Key", tool);
    await expect(resolveProtonPath(steam, [steam], "Missing-Key")).resolves.toBeUndefined();
  });

  it("keeps an explicit native mapping when a custom installation has the same folder name", async () => {
    const steam = await temporaryDirectory();
    const tool = path.join(steam, "compatibilitytools.d", "Native-Key");
    await customTool(path.join(tool, "compatibilitytool.vdf"), "Different-Key", tool);
    await fs.mkdir(path.join(steam, "config"));
    await fs.writeFile(
      path.join(steam, "config", "config.vdf"),
      '"InstallConfigStore" { "Software" { "Valve" { "Steam" { "CompatToolMapping" { "22380" { "name" "Native-Key" } } } } } }',
    );
    await fs.mkdir(path.join(steam, "steamapps", "compatdata", "22380", "pfx"), {
      recursive: true,
    });
    await expect(
      getProtonInfo(steam, [steam], path.join(steam, "steamapps"), "22380"),
    ).resolves.toEqual({ usesProton: false });
  });

  it.each([
    ["Native-Key", "Native-Key"],
    ["Proton 11.0", "proton_11"],
  ])(
    "never invents an official identity for an external custom target at %s",
    async (folder, key) => {
      const steam = await temporaryDirectory();
      const tool = path.join(steam, "steamapps", "common", folder);
      await customTool(
        path.join(steam, "compatibilitytools.d", "external.vdf"),
        "Different-Key",
        tool,
      );
      await expect(resolveProtonPath(steam, [steam], key)).resolves.toBeUndefined();
      await expect(resolveProtonPath(steam, [steam], "Different-Key")).resolves.toBe(
        await fs.realpath(tool),
      );
    },
  );

  it("uses an official manifest's identity when its installation folder has another name", async () => {
    const steam = await temporaryDirectory();
    const tool = await officialTool(steam, "Proton 11.0", "Official Install Folder");
    await expect(resolveProtonPath(steam, [steam], "proton_11")).resolves.toBe(tool);
  });

  it("chooses the newest registered AppID and refuses tied physical installations", async () => {
    const steam = await temporaryDirectory();
    const other = await temporaryDirectory();
    await officialTool(steam, "Proton - Experimental", "Old Experimental", "1493710", "10");
    const newest = await officialTool(
      other,
      "Proton - Experimental",
      "New Experimental",
      "1493710",
      "20",
    );
    await expect(resolveProtonPath(steam, [steam, other], "proton_experimental")).resolves.toBe(
      newest,
    );
    await officialTool(steam, "Proton - Experimental", "Old Experimental", "1493710", "20");
    await expect(resolveProtonPath(steam, [steam, other], "proton_experimental")).rejects.toThrow(
      /multiple installations/,
    );
  });

  it("keeps registered official discovery working beside a malformed app manifest", async () => {
    const steam = await temporaryDirectory();
    const tool = await officialTool(steam, "Proton 11.0");
    await fs.writeFile(path.join(steam, "steamapps", "appmanifest_1.acf"), "not a manifest");
    await expect(resolveProtonPath(steam, [steam], "proton_11")).resolves.toBe(tool);
  });

  it.each([
    ["Proton 10.0", "configured"],
    ["Proton 10.0", "automatic"],
    ["Proton 10.0", "latest path"],
    ["Proton 10.0", "latest name"],
    ["Unrecognized Metadata", "configured"],
    ["Unrecognized Metadata", "automatic"],
    ["Unrecognized Metadata", "latest path"],
    ["Unrecognized Metadata", "latest name"],
  ])("refuses tied AppID with %s through %s selection", async (otherName, consumer) => {
    const steam = await temporaryDirectory();
    const other = await temporaryDirectory();
    await officialTool(steam, "Proton 11.0", "Selected Tool", "1493710", "20");
    await officialTool(other, otherName, "Conflicting Tool", "1493710", "20");
    await fs.mkdir(path.join(steam, "config"));
    await fs.writeFile(
      path.join(steam, "config", "libraryfolders.vdf"),
      `"libraryfolders" { "1" { "path" "${other.replaceAll("\\", "/")}" } }`,
    );
    await fs.mkdir(path.join(steam, "steamapps", "compatdata", "22380", "pfx"), {
      recursive: true,
    });
    const operation =
      consumer === "configured"
        ? resolveProtonPath(steam, [steam, other], "proton_11")
        : consumer === "automatic"
          ? getProtonInfo(steam, [steam, other], path.join(steam, "steamapps"), "22380")
          : consumer === "latest path"
            ? findLatestProton([steam, other])
            : findLatestStableProtonName(steam);
    await expect(operation).rejects.toThrow(/AppID 1493710.*multiple installations/);
  });

  it("preserves a physical prefix choice despite differently named tied AppID records", async () => {
    const steam = await temporaryDirectory();
    const other = await temporaryDirectory();
    const selected = await officialTool(steam, "Proton 10.0", "Selected Tool", "1493710", "20");
    await officialTool(other, "Proton 11.0", "Conflicting Tool", "1493710", "20");
    const compat = path.join(steam, "steamapps", "compatdata", "22380");
    await fs.mkdir(path.join(compat, "pfx"), { recursive: true });
    await fs.writeFile(
      path.join(compat, "config_info"),
      path.join(selected, "files").replaceAll("\\", "/"),
    );
    await expect(
      getProtonInfo(steam, [steam, other], path.join(steam, "steamapps"), "22380"),
    ).resolves.toMatchObject({ usesProton: true, protonPath: selected });
  });

  it("deduplicates tied official AppID aliases to one physical installation", async () => {
    const steam = await temporaryDirectory();
    const other = await temporaryDirectory();
    const selected = await officialTool(steam, "Proton 11.0", "Selected Tool", "1493710", "20");
    const alias = await officialTool(other, "Proton 11.0", "Alias", "1493710", "20");
    await fs.rm(path.join(alias, "proton"));
    await fs.rmdir(alias);
    await fs.symlink(selected, alias, "junction");
    await expect(resolveProtonPath(steam, [steam, other], "proton_11")).resolves.toBe(selected);
  });

  it.each([
    ["Proton - Experimental", undefined],
    ["Proton - Experimental", "unusable prefix identity\n"],
    ["Proton 11.0", undefined],
    ["Proton 11.0", "unusable prefix identity\n"],
  ])(
    "refuses ambiguous newest %s without configured selection and prefix identity %s",
    async (name, recorded) => {
      const steam = await temporaryDirectory();
      const other = await temporaryDirectory();
      await officialTool(steam, name, "First Tool", "1493710", "20");
      await officialTool(other, name, "Second Tool", "1493710", "20");
      const compatData = path.join(steam, "steamapps", "compatdata", "22380");
      await fs.mkdir(path.join(compatData, "pfx"), { recursive: true });
      if (recorded !== undefined)
        await fs.writeFile(path.join(compatData, "config_info"), recorded);
      await expect(
        getProtonInfo(steam, [steam, other], path.join(steam, "steamapps"), "22380"),
      ).rejects.toThrow(/multiple installations/);
    },
  );

  it.each(["Proton - Experimental", "Proton 11.0"])(
    "refuses ambiguous newest %s before a prefix exists",
    async (name) => {
      const steam = await temporaryDirectory();
      const other = await temporaryDirectory();
      await officialTool(steam, name, "First Tool", "1493710", "20");
      await officialTool(other, name, "Second Tool", "1493710", "20");
      const tools = await listInstalledProton(steam, [steam, other]);
      await expect(resolveSteamProton(steam, "22380", undefined, tools)).rejects.toThrow(
        /multiple installations/,
      );
    },
  );

  it.each(["Proton - Experimental", "Proton 11.0"])(
    "refuses ambiguous newest %s in the latest-path helper",
    async (name) => {
      const steam = await temporaryDirectory();
      const other = await temporaryDirectory();
      await officialTool(steam, name, "First Tool", "1493710", "20");
      await officialTool(other, name, "Second Tool", "1493710", "20");
      await expect(findLatestProton([steam, other])).rejects.toThrow(/multiple installations/);
    },
  );

  it("refuses ambiguous newest stable names across registered libraries", async () => {
    const steam = await temporaryDirectory();
    const other = await temporaryDirectory();
    await officialTool(steam, "Proton 11.0", "First Tool", "1493710", "20");
    await officialTool(other, "Proton 11.0", "Second Tool", "1493710", "20");
    await fs.mkdir(path.join(steam, "config"));
    await fs.writeFile(
      path.join(steam, "config", "libraryfolders.vdf"),
      `"libraryfolders" { "1" { "path" "${other.replaceAll("\\", "/")}" } }`,
    );
    await expect(findLatestStableProtonName(steam)).rejects.toThrow(/multiple installations/);
  });

  it.each(["Proton - Experimental", "Proton 11.0"])(
    "preserves an unambiguous physical prefix selection among duplicate %s installations",
    async (name) => {
      const steam = await temporaryDirectory();
      const other = await temporaryDirectory();
      await officialTool(steam, name, "First Tool", "1493710", "20");
      const selected = await officialTool(other, name, "Second Tool", "1493710", "20");
      const compatData = path.join(steam, "steamapps", "compatdata", "22380");
      await fs.mkdir(path.join(compatData, "pfx"), { recursive: true });
      await fs.writeFile(
        path.join(compatData, "config_info"),
        path.join(selected, "files").replaceAll("\\", "/"),
      );
      await expect(
        getProtonInfo(steam, [steam, other], path.join(steam, "steamapps"), "22380"),
      ).resolves.toMatchObject({ usesProton: true, protonPath: selected });
    },
  );

  it.runIf(process.platform === "linux")("discovers a standalone manifest file alias", async () => {
    const steam = await temporaryDirectory();
    const tool = await temporaryDirectory();
    await customTool(path.join(tool, "compatibilitytool.vdf"), "File-Alias-Key", tool);
    await fs.mkdir(path.join(steam, "compatibilitytools.d"));
    await fs.symlink(
      path.join(tool, "missing.vdf"),
      path.join(steam, "compatibilitytools.d", "a-dangling.vdf"),
    );
    await fs.symlink(
      path.join(tool, "compatibilitytool.vdf"),
      path.join(steam, "compatibilitytools.d", "external.vdf"),
    );
    await expect(resolveProtonPath(steam, [steam], "File-Alias-Key")).resolves.toBe(
      await fs.realpath(tool),
    );
  });

  it("resolves relative standalone manifests against an aliased root's physical directory", async () => {
    const steam = await temporaryDirectory();
    const external = await temporaryDirectory();
    const registry = path.join(external, "registry");
    const tool = path.join(external, "External-Proton");
    await customTool(path.join(registry, "external.vdf"), "Relative-Key", tool);
    await fs.writeFile(
      path.join(registry, "external.vdf"),
      '"compatibilitytools" { "compat_tools" { "Relative-Key" { "install_path" "../External-Proton" "from_oslist" "windows" "to_oslist" "linux" } } }',
    );
    await fs.symlink(registry, path.join(steam, "compatibilitytools.d"), "junction");
    expect(await fs.realpath(path.join(steam, "compatibilitytools.d"))).toBe(
      await fs.realpath(registry),
    );
    await expect(resolveProtonPath(steam, [steam], "Relative-Key")).resolves.toBe(
      await fs.realpath(tool),
    );
  });

  it("recognizes the prefix's logical custom-tool alias after canonical discovery", async () => {
    const steam = await temporaryDirectory();
    const tool = await temporaryDirectory();
    const root = path.join(steam, "compatibilitytools.d");
    await fs.mkdir(root);
    await customTool(path.join(tool, "compatibilitytool.vdf"), "Prefix-Key", tool);
    await fs.mkdir(path.join(tool, "files", "share", "default_pfx"), { recursive: true });
    const alias = path.join(root, "Logical-Alias");
    await fs.symlink(tool, alias, "junction");
    expect(await fs.realpath(alias)).toBe(await fs.realpath(tool));
    const template = path.join(alias, "files", "share", "default_pfx");
    const compatdata = path.join(steam, "steamapps", "compatdata", "22380");
    await fs.mkdir(path.join(compatdata, "pfx"), { recursive: true });
    await fs.writeFile(path.join(compatdata, "config_info"), template.replaceAll("\\", "/"));
    await expect(
      getProtonInfo(steam, [steam], path.join(steam, "steamapps"), "22380"),
    ).resolves.toMatchObject({ usesProton: true, protonPath: await fs.realpath(tool) });
  });

  it("discovers official and custom Proton installations by capability", async () => {
    const steamPath = await temporaryDirectory();
    await officialTool(steamPath, "Proton 11.0");
    const custom = path.join(steamPath, "compatibilitytools.d", "GE-Proton11-3");
    await fs.mkdir(custom, { recursive: true });
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
    await Promise.all(
      [
        "Proton 9.0 (Beta)",
        "Proton - Experimental",
        "Proton Hotfix",
        "Proton 9.0",
        "Proton 11.0",
      ].map((name) => officialTool(steamPath, name)),
    );

    await expect(findLatestStableProtonName(steamPath)).resolves.toBe("proton_11");
  });

  it("scans remaining libraries when the first is missing and retains the Experimental path", async () => {
    const library = await temporaryDirectory();
    const experimental = await officialTool(library, "Proton - Experimental");
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
      await officialTool(steam, `Proton ${version}`);
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
      await officialTool(steam, name);
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
