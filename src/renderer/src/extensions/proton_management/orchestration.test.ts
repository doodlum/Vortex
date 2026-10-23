import * as path from "path";

import { describe, expect, it, vi } from "vitest";

import type { IExtensionApi } from "@/types/IExtensionContext";
import type { IState } from "@/types/IState";
import type { IInstalledProton, IPrefixInventory } from "@/util/linux/proton";
import type { ISteamEntry } from "@/util/Steam";

import type { IDependencyInstallOptions } from "./dependencyInstaller";
import {
  createProtonCoordinator,
  matchesActiveLaunch,
  StaleProtonTarget,
  type IProtonTarget,
} from "./orchestration";
import {
  enableDefaultToolRedirect,
  enableShaderCacheRedirect,
  GAME_LAUNCH_WRAPPER,
  SHADER_CACHE_WRAPPER,
} from "./steamShaderSettings";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function target(id = "10", changes: Partial<IProtonTarget> = {}): IProtonTarget {
  return {
    key: `profile-${id}`,
    profile: {
      id: `profile-${id}`,
      gameId: `game-${id}`,
      name: "fixture",
      modState: {},
      lastActivated: 0,
    },
    game: {
      appid: id,
      gamePath: path.resolve("/games", id),
      usesProton: true,
      compatDataPath: path.resolve("/prefix", id),
    } as ISteamEntry,
    steamPath: path.resolve("/steam"),
    selected: "",
    automatic: true,
    isolate: true,
    ...changes,
  };
}

function inventory(winetricks: string[], components: string[] = winetricks): IPrefixInventory {
  return { winetricks, components, compatDataPath: "/prefix", prefixPath: "/prefix/pfx" };
}

function fixture(initial = target()) {
  let current: IProtonTarget | undefined = initial;
  const api = {
    getState: () => ({}) as IState,
    showErrorNotification: vi.fn(),
    sendNotification: vi.fn(),
    dismissNotification: vi.fn(),
  } as unknown as IExtensionApi;
  const ports = {
    target: vi.fn(() => current),
    detect: vi.fn(async () => [] as string[]),
    inspect: vi.fn(async () => inventory([])),
    configured: vi.fn(async () => "proton_experimental"),
    requestInstall: vi.fn(),
    preparePrefix: vi.fn(async () => undefined),
    tools: vi.fn(
      async (): Promise<IInstalledProton[]> => [
        {
          id: "proton-11",
          name: "Proton 11.0",
          path: path.resolve("/steam/steamapps/common/Proton 11.0"),
          source: "steam",
        },
        {
          id: "experimental",
          name: "Proton - Experimental",
          path: path.resolve("/steam/steamapps/common/Proton - Experimental"),
          source: "steam",
        },
      ],
    ),
    read: vi.fn(async (file: string) => (path.basename(file) === "version" ? "11.0" : "11.0")),
    write: vi.fn(async () => undefined),
    install: vi.fn(
      async (
        _api: IExtensionApi,
        _appId: string,
        _verbs: string[],
        _progress?: (progress: number, message: string) => void,
        options?: IDependencyInstallOptions,
      ) => {
        options?.assertCurrent?.();
      },
    ),
    resolveDependency: vi.fn(async () => ({
      steamPath: "/steam",
      gamePath: "/games/10",
      protonPath: "/proton",
      compatDataPath: "/prefix/10",
      protonName: "Proton 11.0",
      readOnlyRoots: ["/steam"],
      runtimeWritePaths: [],
    })),
    getLaunchOptions: vi.fn(async () => "%command%"),
    setLaunchOptions: vi.fn(async (_appId: string, value: string) => value),
    setCompatTool: vi.fn(async () => undefined),
    configureCache: vi.fn(async () => undefined),
    ensureCache: vi.fn(async () => undefined),
    checkCache: vi.fn(async () => undefined),
    ensureLoader: vi.fn(async () => undefined),
    checkLoader: vi.fn(async () => undefined),
    publish: vi.fn(),
  };
  const coordinator = createProtonCoordinator(api, ports);
  const prepare = () => {
    if (current === undefined) throw new Error("Fixture requires target");
    return coordinator.prepareLaunch(
      current.game,
      path.join(current.game.gamePath, "Game.exe"),
      {},
    );
  };
  return {
    api,
    ports,
    coordinator,
    prepare,
    setTarget: (next: IProtonTarget | undefined) => {
      current = next;
    },
  };
}

describe("Proton orchestration consumer contracts", () => {
  it("keeps automatic installation in notifications through record verification and clears the activity", async () => {
    const f = fixture();
    const verifying = deferred<IPrefixInventory>();
    const entered = deferred<void>();
    f.ports.detect.mockResolvedValue(["vcrun2022"]);
    f.ports.inspect.mockResolvedValueOnce(inventory([])).mockImplementationOnce(async () => {
      entered.resolve();
      return verifying.promise;
    });
    f.ports.install.mockImplementation(async (_api, _app, _verbs, progress) => {
      progress?.(100, "Applied components");
    });
    const operation = f.coordinator.request();
    await entered.promise;
    const notifications = vi.mocked(f.api.sendNotification);
    expect(notifications).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "proton-dependencies-10",
        type: "activity",
        noDismiss: true,
        progress: 95,
      }),
    );
    expect(notifications.mock.calls.some(([n]) => n.progress === 100 || n.type === "success")).toBe(
      false,
    );
    expect(f.api.dismissNotification).not.toHaveBeenCalledWith("proton-dependencies-10");
    verifying.resolve(inventory(["vcrun2022"]));
    await operation;
    expect(f.api.dismissNotification).toHaveBeenCalledWith("proton-dependencies-10");
    expect(notifications).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success", id: "proton-dependencies-complete-10" }),
    );
    for (const [notification] of notifications.mock.calls)
      expect(notification.displayMS).toBeUndefined();
  });

  it("clears failed and stale installation activities without reporting success", async () => {
    for (const stale of [false, true]) {
      const f = fixture();
      f.ports.detect.mockResolvedValue(["vcrun2022"]);
      f.ports.install.mockImplementation(async () => {
        if (stale) f.setTarget(target("20"));
        throw new Error("installation failed");
      });
      await f.coordinator.request();
      expect(f.api.dismissNotification).toHaveBeenCalledWith("proton-dependencies-10");
      expect(vi.mocked(f.api.sendNotification).mock.calls.some(([n]) => n.type === "success")).toBe(
        false,
      );
      expect(f.api.showErrorNotification).toHaveBeenCalledTimes(stale ? 0 : 1);
    }
  });

  it("uses a stable error notification for repeated failures and removes it after recovery", async () => {
    const f = fixture();
    f.ports.tools
      .mockRejectedValueOnce(new Error("missing runtime"))
      .mockRejectedValueOnce(new Error("missing runtime"));
    await f.coordinator.request();
    await f.coordinator.request();
    expect(f.api.showErrorNotification).toHaveBeenCalledTimes(2);
    expect(f.api.showErrorNotification).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.any(Error),
      expect.objectContaining({ id: "proton-setup-10", allowReport: false }),
    );
    await f.coordinator.request();
    expect(f.api.dismissNotification).toHaveBeenCalledWith("proton-setup-10");
  });

  it("does not leave activity or claim completion after verification or prefix identity changes", async () => {
    for (const stage of ["records", "prefix", "marker"] as const) {
      const f = fixture();
      f.ports.detect.mockResolvedValue(["vcrun2022"]);
      f.ports.inspect
        .mockResolvedValueOnce(inventory([]))
        .mockResolvedValueOnce(inventory(stage === "records" ? [] : ["vcrun2022"]));
      if (stage === "prefix") {
        // Steam rebuilds the prefix while the recipes are being applied.
        let changed = false;
        f.ports.install.mockImplementation(async () => {
          changed = true;
        });
        f.ports.read.mockImplementation(async (file) =>
          path.basename(file) === "version" && changed ? "12.0" : "11.0",
        );
      }
      if (stage === "marker")
        f.ports.write.mockImplementation(async () => {
          f.setTarget(target("20"));
        });
      await f.coordinator.request();
      expect(f.api.dismissNotification).toHaveBeenCalledWith("proton-dependencies-10");
      expect(
        vi
          .mocked(f.api.sendNotification)
          .mock.calls.some(([n]) => n.progress === 100 || n.type === "success"),
      ).toBe(false);
      if (stage !== "marker") expect(f.ports.write).not.toHaveBeenCalled();
    }
  });

  it("does not create an installation notification when no components are required", async () => {
    const f = fixture();
    await f.coordinator.request();
    expect(f.api.sendNotification).not.toHaveBeenCalled();
    expect(f.ports.install).not.toHaveBeenCalled();
  });

  it("uses the selected runtime and verified prefix for a manual install with automation disabled", async () => {
    const f = fixture(target("10", { automatic: false }));
    f.ports.detect.mockResolvedValue(["xact"]);
    f.ports.inspect.mockResolvedValueOnce(inventory([])).mockResolvedValueOnce(inventory(["xact"]));
    const progress = vi.fn();
    f.ports.install.mockImplementation(async (_api, _appid, _verbs, update) => {
      update?.(55, "Applying components");
    });
    await f.coordinator.installManually("profile-10", progress);
    expect(progress).toHaveBeenCalledWith(55, "Applying components");
    expect(progress).toHaveBeenCalledWith(100, "Mod requirements installed and verified");
    expect(f.ports.resolveDependency).toHaveBeenCalledWith({
      appId: "10",
      steamPath: target().steamPath,
      gamePath: target().game.gamePath,
      compatDataPath: target().game.compatDataPath,
      protonPath: path.resolve("/steam/steamapps/common/Proton - Experimental"),
    });
    expect(f.ports.install).toHaveBeenCalledWith(
      f.api,
      "10",
      ["xact"],
      expect.any(Function),
      expect.objectContaining({ target: await f.ports.resolveDependency.mock.results[0].value }),
    );
    expect(f.ports.write).toHaveBeenCalledOnce();
  });

  it("cancels a queued manual install when the same AppID moves to a different prefix", async () => {
    const f = fixture();
    const waiting = deferred<string>();
    const entered = deferred<void>();
    const installedTools = await f.ports.tools();
    f.ports.tools.mockClear();
    f.ports.tools.mockImplementationOnce(async () => {
      entered.resolve();
      await waiting.promise;
      return installedTools;
    });
    const background = f.coordinator.request();
    await entered.promise;
    const pending = f.coordinator.installManually("profile-10");
    const rejection = expect(pending).rejects.toBeInstanceOf(StaleProtonTarget);
    f.setTarget(
      target("10", {
        key: "profile-10-new-prefix",
        game: { ...target().game, compatDataPath: "/moved/prefix" },
      }),
    );
    waiting.resolve("proton_11");
    await background;
    await rejection;
    expect(f.ports.resolveDependency).not.toHaveBeenCalled();
    expect(f.ports.install).not.toHaveBeenCalled();
  });

  it("does not enable a cache wrapper that fails its launch-environment preflight", async () => {
    const f = fixture();
    f.ports.checkCache.mockRejectedValue(new Error("Python unavailable"));
    await expect(f.prepare()).rejects.toThrow("Python unavailable");
    expect(f.ports.setLaunchOptions).not.toHaveBeenCalled();
    expect(f.ports.install).not.toHaveBeenCalled();
  });
  it("does no dependency work or marker IO when enabled mods require no recipes", async () => {
    const f = fixture();
    await f.prepare();
    expect(f.ports.detect).toHaveBeenCalledOnce();
    expect(f.ports.read.mock.calls.map(([file]) => path.basename(file))).not.toContain(
      ".vortex-dependencies-version",
    );
    expect(f.ports.inspect).not.toHaveBeenCalled();
    expect(f.ports.install).not.toHaveBeenCalled();
    expect(f.ports.write).not.toHaveBeenCalled();
  });

  it("does not treat Wine runtime file indicators as a verified recipe installation", async () => {
    const f = fixture();
    f.ports.detect.mockResolvedValue(["vcrun2022"]);
    f.ports.inspect
      .mockResolvedValueOnce(inventory([], ["vcrun2022"]))
      .mockResolvedValueOnce(inventory(["vcrun2022"]));
    await f.prepare();
    expect(f.ports.install).toHaveBeenCalledWith(
      f.api,
      "10",
      ["vcrun2022"],
      expect.any(Function),
      expect.objectContaining({
        assertCurrent: expect.any(Function),
        force: false,
        target: await f.ports.resolveDependency.mock.results[0].value,
      }),
    );
    expect(f.ports.write).toHaveBeenCalledWith(
      path.join(target().game.compatDataPath!, ".vortex-dependencies-version"),
      "11.0",
    );
  });

  it("rejects a prelaunch install with missing verification records and leaves no success marker", async () => {
    const f = fixture();
    f.ports.detect.mockResolvedValue(["vcrun2022"]);
    f.ports.inspect.mockResolvedValue(inventory([], ["vcrun2022"]));
    await expect(f.prepare()).rejects.toThrow("remain unverified");
    expect(f.ports.write).not.toHaveBeenCalled();
    expect(f.ports.publish).toHaveBeenLastCalledWith(
      expect.objectContaining({ appId: "10", phase: "error" }),
    );
  });

  it("repairs all detected recipes when Proton prefix version changes, even with old winetricks records", async () => {
    const f = fixture();
    f.ports.detect.mockResolvedValue(["vcrun2022", "xinput"]);
    f.ports.read.mockImplementation(async (file) =>
      path.basename(file) === "version" ? "11.0" : "10.0",
    );
    f.ports.inspect.mockResolvedValue(inventory(["vcrun2022", "xinput"]));
    await f.prepare();
    expect(f.ports.install).toHaveBeenCalledWith(
      f.api,
      "10",
      ["vcrun2022", "xinput"],
      expect.any(Function),
      expect.objectContaining({
        assertCurrent: expect.any(Function),
        force: true,
        target: await f.ports.resolveDependency.mock.results[0].value,
      }),
    );
    expect(f.ports.write).toHaveBeenCalledOnce();
  });

  it("honors automatic dependency opt-out", async () => {
    const f = fixture(target("10", { automatic: false }));
    await f.prepare();
    expect(f.ports.detect).not.toHaveBeenCalled();
    expect(f.ports.install).not.toHaveBeenCalled();
    expect(f.ports.write).not.toHaveBeenCalled();
  });

  it("does not drop a new active profile while an old reconciliation is awaiting a scan", async () => {
    const f = fixture();
    const waiting = deferred<string>();
    const entered = deferred<void>();
    const installedTools = await f.ports.tools();
    f.ports.tools.mockClear();
    f.ports.tools.mockImplementationOnce(async () => {
      entered.resolve();
      await waiting.promise;
      return installedTools;
    });
    f.ports.configured.mockResolvedValue("proton_10");
    const first = f.coordinator.request();
    await entered.promise;
    f.setTarget(target("20"));
    const second = f.coordinator.request();
    waiting.resolve("proton_11");
    await Promise.all([first, second]);
    expect(f.ports.setCompatTool).toHaveBeenCalledExactlyOnceWith(
      "20",
      "proton_experimental",
      expect.objectContaining({
        steamPath: target("20").steamPath,
        gamePath: target("20").game.gamePath,
        assertCurrent: expect.any(Function),
      }),
    );
    expect(f.ports.configureCache).toHaveBeenCalledWith("20", expect.any(Array));
    expect(
      f.ports.publish.mock.calls.some(
        ([status]) => status.appId === "10" && status.phase === "error",
      ),
    ).toBe(false);
  });

  it("rejects a stale direct launch rather than preparing whichever profile is active later", async () => {
    const f = fixture();
    const waiting = deferred<string>();
    const entered = deferred<void>();
    const installedTools = await f.ports.tools();
    f.ports.tools.mockClear();
    f.ports.tools.mockImplementationOnce(async () => {
      entered.resolve();
      await waiting.promise;
      return installedTools;
    });
    const background = f.coordinator.request();
    await entered.promise;
    const queuedLaunch = f.prepare();
    const rejection = expect(queuedLaunch).rejects.toBeInstanceOf(StaleProtonTarget);
    f.setTarget(target("20"));
    waiting.resolve("proton_11");
    await background;
    await rejection;
    expect(f.ports.install).not.toHaveBeenCalled();
  });

  it("guards installer subprocesses and prevents a stale marker write after profile change", async () => {
    const f = fixture();
    f.ports.detect.mockResolvedValue(["vcrun2022"]);
    f.ports.install.mockImplementation(async (_api, _appid, _verbs, _progress, options) => {
      f.setTarget(target("20"));
      options?.assertCurrent?.();
    });
    await expect(f.prepare()).rejects.toBeInstanceOf(StaleProtonTarget);
    expect(f.ports.write).not.toHaveBeenCalled();
  });

  it("refuses a success marker when Steam changes prefix version during installation", async () => {
    const f = fixture();
    f.ports.detect.mockResolvedValue(["vcrun2022"]);
    f.ports.inspect
      .mockResolvedValueOnce(inventory([]))
      .mockResolvedValueOnce(inventory(["vcrun2022"]));
    // Steam rebuilds the prefix while the recipes are being applied.
    let changed = false;
    f.ports.install.mockImplementation(async () => {
      changed = true;
    });
    f.ports.read.mockImplementation(async (file: string) =>
      path.basename(file) === "version" && changed ? "12.0" : "11.0",
    );
    await expect(f.prepare()).rejects.toThrow("prefix changed");
    expect(f.ports.write).not.toHaveBeenCalled();
  });

  it("provisions and configures cache helper before enabling the Steam redirect", async () => {
    const f = fixture();
    const result = await f.prepare();
    expect(result?.shaderWrapper).toBe(SHADER_CACHE_WRAPPER);
    expect(f.ports.ensureCache.mock.invocationCallOrder[0]).toBeLessThan(
      f.ports.configureCache.mock.invocationCallOrder[0],
    );
    expect(f.ports.configureCache.mock.invocationCallOrder[0]).toBeLessThan(
      f.ports.setLaunchOptions.mock.invocationCallOrder[0],
    );
    f.setTarget(target("20"));
    expect(result?.assertCurrent).toThrow(StaleProtonTarget);
  });

  it("removes owned shader and default-loader redirects after preferences and primary tool change", async () => {
    const f = fixture(target("10", { isolate: false }));
    const previous = enableDefaultToolRedirect(
      enableShaderCacheRedirect(
        "ENV=original %command% --user-argument",
        "10",
        SHADER_CACHE_WRAPPER,
      ),
      "/old/loader.exe",
      GAME_LAUNCH_WRAPPER,
    );
    f.ports.getLaunchOptions.mockResolvedValue(previous);
    await f.prepare();
    expect(f.ports.setLaunchOptions).toHaveBeenCalledWith(
      "10",
      "ENV=original %command% --user-argument",
      expect.objectContaining({ gamePath: target().game.gamePath, steamPath: target().steamPath }),
    );
    expect(f.ports.ensureCache).not.toHaveBeenCalled();
  });

  it("does not require CDP for an unchanged runtime and allows prepared direct launch when Steam options cannot be read", async () => {
    const f = fixture();
    f.ports.getLaunchOptions.mockRejectedValue(new Error("Steam not running"));
    const result = await f.prepare();
    expect(result?.shaderWrapper).toBe(SHADER_CACHE_WRAPPER);
    expect(f.ports.setCompatTool).not.toHaveBeenCalled();
    expect(f.ports.publish).toHaveBeenLastCalledWith(
      expect.objectContaining({
        appId: "10",
        phase: "error",
        message: expect.stringContaining("Steam launch settings"),
      }),
    );
  });

  it("blocks direct launch if a required Steam runtime change fails", async () => {
    const f = fixture();
    f.ports.configured.mockResolvedValue("proton_10");
    f.ports.setCompatTool.mockRejectedValue(new Error("Start Steam"));
    await expect(f.prepare()).rejects.toThrow("Start Steam");
    expect(f.ports.install).not.toHaveBeenCalled();
  });

  it("ignores native helpers, sibling paths, unrelated explicit game IDs and other Steam entries", async () => {
    const f = fixture();
    await expect(
      f.coordinator.prepareLaunch(target().game, "/usr/bin/native", {}),
    ).resolves.toBeUndefined();
    await expect(
      f.coordinator.prepareLaunch(
        undefined,
        path.join(`${target().game.gamePath}-other`, "Tool.exe"),
        {},
      ),
    ).resolves.toBeUndefined();
    await expect(
      f.coordinator.prepareLaunch(target().game, path.join(target().game.gamePath, "Tool.exe"), {
        gameId: "other",
      }),
    ).resolves.toBeUndefined();
    await expect(
      f.coordinator.prepareLaunch(target("20").game, "/elsewhere/Tool.exe", { gameId: "game-10" }),
    ).resolves.toBeUndefined();
    expect(f.ports.tools).not.toHaveBeenCalled();
    expect(
      matchesActiveLaunch(target(), "/elsewhere/Tool.exe", { gameId: "game-10" }, target().game),
    ).toBe(true);
  });

  it("observes feature/install identity changes while ignoring unrelated Redux writes", async () => {
    const f = fixture();
    f.coordinator.observe();
    f.coordinator.observe();
    await f.coordinator.request();
    expect(f.ports.tools).toHaveBeenCalledTimes(2);
    f.setTarget(target("10", { key: "profile-10-new-feature", isolate: false }));
    f.coordinator.observe();
    await f.coordinator.request();
    expect(f.ports.tools).toHaveBeenCalledTimes(4);
  });
});

describe("Proton prefix downgrade protection", () => {
  const PROTON_9 = path.resolve("/steam/steamapps/common/Proton 9.0");
  const EXPERIMENTAL = path.resolve("/steam/steamapps/common/Proton - Experimental");
  const tools = [
    { id: "proton-9", name: "Proton 9.0", path: PROTON_9, source: "steam" as const },
    {
      id: "experimental",
      name: "Proton - Experimental",
      path: EXPERIMENTAL,
      source: "steam" as const,
    },
  ];
  const scripts: Record<string, string> = {
    [path.join(PROTON_9, "proton")]: 'CURRENT_PREFIX_VERSION="9.0-203"\n',
    [path.join(EXPERIMENTAL, "proton")]: 'CURRENT_PREFIX_VERSION="10.0-100"\n',
  };
  const downgradeFixture = (selected: string) => {
    const f = fixture(target("10", { selected }));
    f.ports.tools.mockResolvedValue(tools);
    f.ports.configured.mockResolvedValue("proton_experimental");
    f.ports.detect.mockResolvedValue(["vcrun2022"]);
    f.ports.inspect
      .mockResolvedValueOnce(inventory([]))
      .mockResolvedValueOnce(inventory(["vcrun2022"]));
    f.ports.read.mockImplementation(async (file: string) =>
      path.basename(file) === "version" ? "10.0-100" : (scripts[file] ?? "10.0-100"),
    );
    return f;
  };

  it("keeps the recommended Experimental runtime that built the prefix", async () => {
    const f = downgradeFixture("");
    await f.prepare();
    expect(f.ports.setCompatTool).not.toHaveBeenCalled();
    expect(f.ports.resolveDependency).toHaveBeenCalledWith(
      expect.objectContaining({ protonPath: EXPERIMENTAL }),
    );
    expect(f.ports.install).toHaveBeenCalledOnce();
  });

  it("moves Steam back to a runtime that can drive the prefix after an earlier downgrade", async () => {
    const f = downgradeFixture("");
    // Steam was already switched to the older stable release, as an earlier build did.
    f.ports.configured.mockResolvedValue("proton_9");
    await f.prepare();
    expect(f.ports.setCompatTool).toHaveBeenCalledWith(
      "10",
      "proton_experimental",
      expect.objectContaining({ steamPath: path.resolve("/steam") }),
    );
    expect(f.ports.resolveDependency).toHaveBeenCalledWith(
      expect.objectContaining({ protonPath: EXPERIMENTAL }),
    );
    expect(f.ports.install).toHaveBeenCalledOnce();
  });

  it("lets an explicitly selected older Proton downgrade the prefix first, as Steam would", async () => {
    const f = downgradeFixture(PROTON_9);
    let prefixVersion = "10.0-100";
    f.ports.read.mockImplementation(async (file: string) =>
      path.basename(file) === "version" ? prefixVersion : (scripts[file] ?? prefixVersion),
    );
    f.ports.preparePrefix.mockImplementation(async () => {
      prefixVersion = "9.0-203";
    });
    await f.prepare();
    expect(f.ports.preparePrefix).toHaveBeenCalledOnce();
    expect(f.ports.preparePrefix.mock.invocationCallOrder[0]).toBeLessThan(
      f.ports.install.mock.invocationCallOrder[0],
    );
    expect(f.ports.resolveDependency).toHaveBeenCalledWith(
      expect.objectContaining({ protonPath: PROTON_9 }),
    );
  });

  it("refuses to install when the selected Proton could not downgrade the prefix", async () => {
    const f = downgradeFixture(PROTON_9);
    await expect(f.prepare()).rejects.toThrow("prefix was created by Proton 10");
    expect(f.ports.preparePrefix).toHaveBeenCalledOnce();
    expect(f.ports.install).not.toHaveBeenCalled();
    expect(f.ports.write).not.toHaveBeenCalled();
  });
});

describe("Recommended Proton", () => {
  it("asks Steam once to install Proton Experimental when it is missing, then reports progress", async () => {
    const f = fixture();
    f.ports.tools.mockResolvedValue([
      {
        id: "proton-11",
        name: "Proton 11.0",
        path: path.resolve("/steam/steamapps/common/Proton 11.0"),
        source: "steam",
      },
    ]);
    await expect(f.prepare()).rejects.toThrow("Steam is installing Proton Experimental");
    await expect(f.prepare()).rejects.toThrow("Steam is installing Proton Experimental");
    expect(f.ports.requestInstall).toHaveBeenCalledExactlyOnceWith("1493710");
    expect(f.ports.setCompatTool).not.toHaveBeenCalled();
    expect(f.ports.install).not.toHaveBeenCalled();
  });

  it("points Steam at Proton Experimental by default instead of an older stable release", async () => {
    const f = fixture();
    f.ports.configured.mockResolvedValue("proton_11");
    await f.prepare();
    expect(f.ports.setCompatTool).toHaveBeenCalledWith(
      "10",
      "proton_experimental",
      expect.objectContaining({ steamPath: path.resolve("/steam") }),
    );
  });
});
