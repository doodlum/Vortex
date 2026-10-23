import * as path from "path";

import {
  ChaosFS,
  InMemoryFSBuilder,
  QualifiedPath,
  type ChaosRule,
  type FileSystem,
} from "@vortex/shared/filesystem";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { installInMemoryFS } from "../test-utils/fsApi";
import type { IExtensionApi } from "../types/IExtensionContext";
import { GameEntryNotFound } from "../types/IGameStore";
import type * as ProtonModule from "./linux/proton";
import type { ISteamEntry } from "./Steam";
import { Steam } from "./Steam";

// Steam.ts builds its singleton at import time, and on Linux that constructor calls
// findLinuxSteamPath straight away - before any binding declared below this file's
// imports exists. vi.hoisted runs ahead of the imports, so the mocks can read it.
// (On Windows the equivalent RegGetValue call sits in a try/catch that swallows the
// ReferenceError, which is why a plain `let` only fails on CI.)
const steam = vi.hoisted(() => ({ installed: true, baseFolder: "C:\\Steam" }));
const proton = vi.hoisted(() => ({ info: vi.fn(), installed: vi.fn() }));
const steamHome = vi.hoisted(() => ({ find: vi.fn().mockResolvedValue("/steam-home") }));
const preparation = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("@/extensions/proton_management/orchestration", () => ({
  prepareProtonLaunch: preparation.run,
}));

const BASE_FOLDER = steam.baseFolder;
const ALT_LIBRARY = path.join("D:", "SteamLibrary");
const THIRD_LIBRARY = path.join("E:", "Games");

const MANIFEST = `"AppState"
{
  "appid" "42"
  "name" "Test Game"
  "installdir" "TestGame"
  "LastOwner" "1"
  "LastUpdated" "0"
}`;

/** Mini appmanifest with the depot values the telemetry needs: depot ids whose
    file order differs from depot-id order, inline-brace entries like real Steam
    files write them, plus branch/language and a shared (redistributable) depot. */
const DEPOT_MANIFEST = `"AppState"
{
  "appid" "42"
  "name" "Test Game"
  "installdir" "TestGame"
  "buildid" "12345"
  "TargetBuildID" "12346"
  "StateFlags" "4"
  "InstalledDepots"
  {
    "7" { "manifest" "m7" "size" "1" }
    "3" { "manifest" "m3" "size" "2" "dlcappid" "1" }
  }
  "SharedDepots"
  {
    "5" "4"
  }
  "UserConfig"
  {
    "language" "english"
    "BetaKey" "beta-2"
  }
  "MountedConfig"
  {
    "language" "english"
    "BetaKey" "beta-2"
  }
}`;

/** simple-vdf rejects inline braces, so every block needs its own lines. */
const vdf = (...lines: string[]): string => lines.join("\n");

/**
 * Steam escapes the separators, so JSON.stringify happens to produce exactly
 * the quoting a real file uses.
 */
const libraryFolders = (
  libPaths: string[],
  opts: { key?: string; firstIndex?: number } = {},
): string => {
  const { key = "libraryfolders", firstIndex = 1 } = opts;
  return vdf(
    `"${key}"`,
    "{",
    ...libPaths.flatMap((libPath, idx) => [
      `  "${idx + firstIndex}"`,
      "  {",
      `    "path"  ${JSON.stringify(libPath)}`,
      "  }",
    ]),
    "}",
  );
};

const gamePathIn = (library: string): string =>
  path.join(library, "steamapps", "common", "TestGame");

/** The libraryfolders.vdf contents to seed; tests set this before scanning. */
let libraryFoldersVdf = "";
/** Fault rules wrapped around the seeded FS; tests set these before scanning. */
let chaosRules: ChaosRule[] = [];

vi.mock("winapi-bindings", () => ({
  RegGetValue: () => {
    if (!steam.installed) {
      throw new Error("registry key not found");
    }
    return { value: steam.baseFolder };
  },
}));

vi.mock("./linux/steamPaths", () => ({
  findLinuxSteamPath: () => (steam.installed ? steam.baseFolder : undefined),
}));

vi.mock("./linux/steamClientHome", () => ({ findSteamClientHome: steamHome.find }));

vi.mock("./linux/proton", async (importOriginal) => ({
  ...(await importOriginal<typeof ProtonModule>()),
  getProtonInfo: proton.info,
  listInstalledProton: proton.installed,
}));

/**
 * Seeds an in-memory FS behind window.api.fs: the libraryfolders.vdf plus one
 * appmanifest per known library, then wraps it in ChaosFS so tests can inject
 * parseError-classifiable faults.
 */
const installTestFS = (manifest: string = MANIFEST): (() => void) => {
  const { fs, restore } = installInMemoryFS((builder) => {
    builder.file(QualifiedPath.fromNative(path.join(BASE_FOLDER, "config", "libraryfolders.vdf")), {
      type: "text",
      data: libraryFoldersVdf,
    });

    for (const library of [BASE_FOLDER, ALT_LIBRARY, THIRD_LIBRARY]) {
      builder.file(
        QualifiedPath.fromNative(path.join(library, "steamapps", "appmanifest_42.acf")),
        {
          type: "text",
          data: manifest,
        },
      );
    }
  });

  (window as unknown as { api?: { fs?: FileSystem } }).api!.fs = new ChaosFS(fs, chaosRules);
  return restore;
};

/**
 * Drive the manager-owned scan, then read the data through allGames -
 * allGames itself no longer triggers a parse.
 */
const scanAllGames = async (manifest: string = MANIFEST) => {
  const restore = installTestFS(manifest);
  try {
    const store = new Steam();
    await store.reloadGames();
    return store.allGames();
  } finally {
    restore();
  }
};

describe("Steam.allGames", () => {
  beforeEach(() => {
    proton.info.mockResolvedValue({ usesProton: false });
    proton.installed.mockResolvedValue([]);
    steam.installed = true;
    chaosRules = [];
    libraryFoldersVdf = libraryFolders([]);
  });

  it("finds nothing when Steam isn't installed", async () => {
    steam.installed = false;

    await expect(scanAllGames()).resolves.toEqual([]);
  });

  it.each(["fs:not-found", "fs:no-permissions"] satisfies ChaosRule["fault"]["kind"][])(
    "falls back to the base folder on %s",
    async (kind) => {
      chaosRules = [
        {
          fault: { kind },
          op: "readFile",
          path: (p) => p.value.includes("libraryfolders.vdf"),
        },
      ];

      const entries = await scanAllGames();

      expect(entries.map((entry) => entry.gamePath)).toEqual([gamePathIn(BASE_FOLDER)]);
    },
  );

  it("propagates errors other than not-found/no-permissions", async () => {
    chaosRules = [
      {
        fault: {
          kind: "os:generic",
          originalCode: "EIO",
          message: "EIO: i/o error, read 'libraryfolders.vdf'",
        },
        op: "readFile",
        path: (p) => p.value.includes("libraryfolders.vdf"),
      },
    ];

    const restore = installTestFS();
    try {
      await expect(new Steam().reloadGames()).rejects.toThrow("EIO");
    } finally {
      restore();
    }
  });

  it.each([
    ["an empty file", ""],
    ["no libraryfolders key", vdf('"something else"', "{", "}")],
    ["libraryfolders holding a leaf value", vdf('"libraryfolders"  "nonsense"')],
    ["an entry holding a leaf value", vdf('"libraryfolders"', "{", '  "1"  "nonsense"', "}")],
    [
      "an entry whose path is a block",
      vdf(
        '"libraryfolders"',
        "{",
        '  "1"',
        "  {",
        '    "path"',
        "    {",
        '      "nested"  "value"',
        "    }",
        "  }",
        "}",
      ),
    ],
  ])("falls back to the base folder given %s", async (_label, contents) => {
    libraryFoldersVdf = contents;

    const entries = await scanAllGames();

    expect(entries.map((entry) => entry.gamePath)).toEqual([gamePathIn(BASE_FOLDER)]);
  });

  it("scans the alternate libraries listed in libraryfolders.vdf", async () => {
    libraryFoldersVdf = libraryFolders([ALT_LIBRARY]);

    const entries = await scanAllGames();

    expect(entries.map((entry) => entry.gamePath)).toEqual([
      gamePathIn(BASE_FOLDER),
      gamePathIn(ALT_LIBRARY),
    ]);
  });

  it("matches the libraryfolders key case-insensitively", async () => {
    libraryFoldersVdf = libraryFolders([ALT_LIBRARY], { key: "LibraryFolders" });

    const entries = await scanAllGames();

    expect(entries.map((entry) => entry.gamePath)).toEqual([
      gamePathIn(BASE_FOLDER),
      gamePathIn(ALT_LIBRARY),
    ]);
  });

  it("reads libraries numbered from zero", async () => {
    libraryFoldersVdf = libraryFolders([ALT_LIBRARY, THIRD_LIBRARY], { firstIndex: 0 });

    const entries = await scanAllGames();

    expect(entries.map((entry) => entry.gamePath)).toEqual([
      gamePathIn(BASE_FOLDER),
      gamePathIn(ALT_LIBRARY),
      gamePathIn(THIRD_LIBRARY),
    ]);
  });

  it("stops at the first gap in the numbering", async () => {
    libraryFoldersVdf = vdf(
      '"libraryfolders"',
      "{",
      '  "0"',
      "  {",
      `    "path"  ${JSON.stringify(ALT_LIBRARY)}`,
      "  }",
      '  "2"',
      "  {",
      `    "path"  ${JSON.stringify(THIRD_LIBRARY)}`,
      "  }",
      "}",
    );

    const entries = await scanAllGames();

    expect(entries.map((entry) => entry.gamePath)).toEqual([
      gamePathIn(BASE_FOLDER),
      gamePathIn(ALT_LIBRARY),
    ]);
  });

  it("keeps the InstalledDepots file order, which depot-id sort would lose", async () => {
    const entries = await scanAllGames(DEPOT_MANIFEST);

    expect(entries[0]?.installData).toEqual({
      appId: 42,
      buildId: 12345,
      stateFlags: 4,
      targetBuildId: 12346,
      branch: "beta-2",
      language: "english",
      mountedLanguage: "english",
      depots: [
        { depotId: 7, manifestId: "m7", dlcAppId: null },
        { depotId: 3, manifestId: "m3", dlcAppId: "1" },
      ],
      sharedDepots: [{ depotId: 5, ownerAppId: 4 }],
    });
  });

  it("normalizes the default branch to null", async () => {
    const entries = await scanAllGames(DEPOT_MANIFEST.replace("beta-2", "public"));

    expect(entries[0]?.installData?.branch).toBeNull();
  });

  it("skips install data when the manifest lacks build or state fields", async () => {
    const entries = await scanAllGames();

    expect(entries[0]?.installData).toBeUndefined();
  });
});

describe("Steam Proton launches", () => {
  beforeEach(() => {
    preparation.run.mockReset().mockResolvedValue(undefined);
    steamHome.find.mockReset().mockResolvedValue("/steam-home");
  });

  const gamePath = path.join(BASE_FOLDER, "steamapps", "common", "TestGame");
  const entry = { appid: "42", gameStoreId: "steam", name: "Test", gamePath } as ISteamEntry;
  const makeApi = (discoveryPath: string, override = "") => {
    const runExecutable = vi.fn().mockResolvedValue(undefined);
    const state = {
      settings: {
        profiles: { activeProfileId: "one" },
        gameMode: { discovered: { test: { path: discoveryPath } } },
      },
      persistent: {
        profiles: { one: { id: "one", gameId: "test", features: { "proton-version": override } } },
      },
    };
    return {
      api: { getState: () => state, runExecutable } as unknown as IExtensionApi,
      runExecutable,
    };
  };

  it("prepares dependencies before runtime conversion and protects the actual direct child without replacing the chosen utility", async () => {
    const assertCurrent = vi.fn();
    preparation.run.mockResolvedValue({
      appId: "42",
      protonPath: "/prepared-proton",
      shaderWrapper: "/private/vortex-shader-cache-run",
      assertCurrent,
    });
    proton.info.mockResolvedValue({
      usesProton: true,
      protonPath: "/stale-proton",
      compatDataPath: "/prefix",
    });
    const { api, runExecutable } = makeApi(gamePath);
    await new Steam().runToolWithProton(
      api,
      "/outside/utility.exe",
      ["$(literal)", "argument.exe"],
      { gameId: "test" },
      entry,
    );
    expect(preparation.run).toHaveBeenCalledExactlyOnceWith(api, entry, "/outside/utility.exe", {
      gameId: "test",
    });
    expect(runExecutable).toHaveBeenCalledExactlyOnceWith(
      "/private/vortex-shader-cache-run",
      [
        "42",
        path.join("/prepared-proton", "proton"),
        "run",
        "/outside/utility.exe",
        "$(literal)",
        "argument.exe",
      ],
      expect.objectContaining({
        shell: false,
        env: expect.objectContaining({ SteamAppId: "42", STEAM_COMPAT_DATA_PATH: "/prefix" }),
      }),
    );
    expect(assertCurrent).toHaveBeenCalledOnce();
  });

  for (const protectedCache of [false, true]) {
    it("launches Flatpak Proton on the host with cache protection " + protectedCache, async () => {
      const original = process;
      vi.stubGlobal("process", { ...original, platform: "linux" });
      vi.stubEnv("IS_FLATPAK", "true");
      vi.stubEnv("VORTEX_SANDBOX_ONLY", "must not reach host flags");
      vi.stubEnv("PROTON_LOG", "1");
      vi.stubEnv("SteamAppId", "999");
      try {
        const assertCurrent = vi.fn();
        preparation.run.mockResolvedValue({
          protonPath: "/chosen-proton",
          appId: "42",
          shaderWrapper: protectedCache ? "/host/bin/cache-run" : undefined,
          assertCurrent,
        });
        proton.info.mockResolvedValue({
          usesProton: true,
          protonPath: "/stale",
          compatDataPath: "/prefix",
        });
        const { api, runExecutable } = makeApi(gamePath);
        const onSpawned = vi.fn(),
          onExit = vi.fn();
        await new Steam().runToolWithProton(
          api,
          '/outside/quoted "tool".exe',
          ['a "quote"', "$(literal)", "--host"],
          {
            cwd: "/games/working directory",
            env: { CUSTOM: 'literal "value"', EMPTY: "" },
            onSpawned,
            onExit,
            detach: false,
          },
          entry,
        );
        const [command, args, options] = runExecutable.mock.calls[0];
        expect(command).toBe("flatpak-spawn");
        expect(args).toEqual([
          "--host",
          "--directory=/games/working directory",
          "--env=PROTON_LOG=1",
          '--env=CUSTOM=literal "value"',
          "--env=EMPTY=",
          "--env=HOME=/steam-home",
          "--env=SteamAppId=42",
          "--env=SteamGameId=42",
          "--env=SteamOverlayGameId=42",
          "--env=STEAM_COMPAT_APP_ID=42",
          "--env=STEAM_COMPAT_INSTALL_PATH=" + gamePath,
          "--env=STEAM_COMPAT_DATA_PATH=/prefix",
          "--env=STEAM_COMPAT_CLIENT_INSTALL_PATH=" + BASE_FOLDER,
          "--env=WINEPREFIX=" + path.join("/prefix", "pfx"),
          ...(protectedCache ? ["/host/bin/cache-run", "42"] : []),
          path.join("/chosen-proton", "proton"),
          "run",
          '/outside/quoted "tool".exe',
          'a "quote"',
          "$(literal)",
          "--host",
        ]);
        expect(options).toEqual(
          expect.objectContaining({ cwd: "/", shell: false, onSpawned, onExit, detach: false }),
        );
        expect(args.join(" ")).not.toContain("VORTEX_SANDBOX_ONLY");
        expect(assertCurrent).toHaveBeenCalledOnce();
      } finally {
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
      }
    });
  }

  it("uses the original launcher directory when Flatpak callers omit cwd", async () => {
    const original = process;
    vi.stubGlobal("process", { ...original, platform: "linux" });
    vi.stubEnv("IS_FLATPAK", "true");
    try {
      proton.info.mockResolvedValue({
        usesProton: true,
        protonPath: "/runtime/proton10",
        compatDataPath: "/prefix",
      });
      const { api, runExecutable } = makeApi(gamePath);
      await new Steam().runToolWithProton(api, "/outside/tool.exe", [], {}, entry);
      expect(runExecutable.mock.calls[0][1][1]).toBe(
        "--directory=" + path.dirname(path.join("/runtime/proton10", "proton")),
      );
      expect(runExecutable.mock.calls[0][2].cwd).toBe("/");
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });

  it("does not host-wrap Windows commands even with the Flatpak marker", async () => {
    const original = process;
    vi.stubGlobal("process", { ...original, platform: "win32" });
    vi.stubEnv("IS_FLATPAK", "true");
    try {
      proton.info.mockResolvedValue({
        usesProton: true,
        protonPath: "/runtime/proton10",
        compatDataPath: "/prefix",
      });
      const { api, runExecutable } = makeApi(gamePath);
      await new Steam().runToolWithProton(api, "/outside/tool.exe", [], {}, entry);
      expect(runExecutable.mock.calls[0][0]).toBe(path.join("/runtime/proton10", "proton"));
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });

  it("does not launch if preparation becomes stale before dispatch", async () => {
    preparation.run.mockResolvedValue({
      protonPath: "/prepared-proton",
      assertCurrent: () => {
        throw new Error("stale profile");
      },
    });
    proton.info.mockResolvedValue({
      usesProton: true,
      protonPath: "/stale-proton",
      compatDataPath: "/prefix",
    });
    const { api, runExecutable } = makeApi(gamePath);
    await expect(
      new Steam().runToolWithProton(api, "/outside/utility.exe", [], {}, entry),
    ).rejects.toThrow("stale profile");
    expect(runExecutable).not.toHaveBeenCalled();
  });

  it("resolves fresh Steam settings and preserves literal argv for an external tool", async () => {
    proton.info.mockResolvedValue({
      usesProton: true,
      protonPath: "/new-proton",
      compatDataPath: "/prefix",
    });
    const { api, runExecutable } = makeApi(gamePath);
    await new Steam().runToolWithProton(
      api,
      "/outside/Tool.exe",
      ["argument with spaces", "$(literal)"],
      { env: { CUSTOM: "value" } },
      { ...entry, protonPath: "/stale-proton" },
    );
    expect(runExecutable).toHaveBeenCalledWith(
      path.join("/new-proton", "proton"),
      ["run", "/outside/Tool.exe", "argument with spaces", "$(literal)"],
      expect.objectContaining({
        shell: false,
        env: expect.objectContaining({
          CUSTOM: "value",
          STEAM_COMPAT_DATA_PATH: "/prefix",
          HOME: "/steam-home",
          SteamAppId: "42",
          SteamGameId: "42",
        }),
      }),
    );
  });

  it("skips SDK discovery when the caller explicitly supplies HOME", async () => {
    steamHome.find.mockRejectedValue(
      Object.assign(new Error("unreadable inherited SDK"), { code: "EACCES" }),
    );
    proton.info.mockResolvedValue({
      usesProton: true,
      protonPath: "/steam-proton",
      compatDataPath: "/prefix",
    });
    const { api, runExecutable } = makeApi(gamePath);
    await new Steam().runToolWithProton(
      api,
      "/outside/Tool.exe",
      [],
      { env: { HOME: "/explicit-home" } },
      entry,
    );
    expect(steamHome.find).not.toHaveBeenCalled();
    expect(runExecutable).toHaveBeenCalledWith(
      path.join("/steam-proton", "proton"),
      ["run", "/outside/Tool.exe"],
      expect.objectContaining({
        env: expect.objectContaining({
          HOME: "/explicit-home",
          SteamAppId: "42",
          SteamGameId: "42",
        }),
      }),
    );
  });
  it("uses only the matching active game's profile override", async () => {
    proton.info.mockResolvedValue({
      usesProton: true,
      protonPath: "/steam-proton",
      compatDataPath: "/prefix",
    });
    proton.installed.mockResolvedValue([{ path: "/override" }]);
    const own = makeApi(gamePath, "/override");
    await new Steam().runToolWithProton(own.api, "/outside/Tool.exe", [], {}, entry);
    expect(own.runExecutable.mock.calls[0][0]).toBe(path.join("/override", "proton"));
    const other = makeApi(gamePath + "Other", "/override");
    await new Steam().runToolWithProton(other.api, "/outside/Tool.exe", [], {}, entry);
    expect(other.runExecutable.mock.calls[0][0]).toBe(path.join("/steam-proton", "proton"));
  });

  it("refuses a missing profile override and never retries the Windows executable directly", async () => {
    proton.info.mockResolvedValue({
      usesProton: true,
      protonPath: "/steam-proton",
      compatDataPath: "/prefix",
    });
    proton.installed.mockResolvedValue([]);
    const { api, runExecutable } = makeApi(gamePath, "/missing");
    await expect(
      new Steam().runToolWithProton(api, "/outside/Tool.exe", [], {}, entry),
    ).rejects.toThrow("no longer installed");
    expect(runExecutable).not.toHaveBeenCalled();
    proton.info.mockResolvedValue({ usesProton: false });
    await expect(
      new Steam().runToolWithProton(api, "/outside/Tool.exe", [], {}, entry),
    ).rejects.toThrow("No installed Proton");
    expect(runExecutable).not.toHaveBeenCalled();
  });
});
