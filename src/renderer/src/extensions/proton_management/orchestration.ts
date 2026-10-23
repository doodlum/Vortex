import * as fs from "fs/promises";
import * as path from "path";

import { unknownToError } from "@vortex/shared";
import { ProcessCanceled } from "@vortex/shared/errors";

import type { IExtensionApi, IRunParameters, IRunOptions } from "@/types/IExtensionContext";
import type { IState } from "@/types/IState";
import { isPathInsideGame, isSameGamePath } from "@/util/linux/gamePath";
import {
  getConfiguredProtonName,
  inspectPrefix,
  isWindowsExecutable,
  listInstalledProton,
  prefixDowngradeWarning,
  protonConfigName,
  protonPrefixVersion,
  protonScriptPath,
  RECOMMENDED_PROTON,
  type IInstalledProton,
} from "@/util/linux/proton";
import { resolveDependencyTarget } from "@/util/linux/protonMetadata";
import { findLinuxSteamPath } from "@/util/linux/steamPaths";
import type { ISteamEntry } from "@/util/Steam";

import { activeProfile } from "../profile_management/selectors";
import type { IProfile } from "../profile_management/types/IProfile";
import { installDependencies } from "./dependencyInstaller";
import type { DependencyProgress } from "./dependencyInstaller";
import { detectModRuntimeDependencies, enabledModPaths } from "./modRequirements";
import { activeProtonGame } from "./selection";
import { publishProtonSetupStatus } from "./setupStatus";
import {
  configureShaderCache,
  checkShaderCacheWrapper,
  checkGameLaunchWrapper,
  disableDefaultToolRedirect,
  disableShaderCacheRedirect,
  enableDefaultToolRedirect,
  enableShaderCacheRedirect,
  ensureGameLaunchWrapper,
  ensureShaderCacheWrapper,
  GAME_LAUNCH_WRAPPER,
  getSteamLaunchOptions,
  setSteamCompatTool,
  setSteamLaunchOptions,
  SHADER_CACHE_WRAPPER,
} from "./steamShaderSettings";

export interface IProtonTarget {
  key: string;
  profile: IProfile;
  game: ISteamEntry;
  steamPath: string;
  selected: string;
  automatic: boolean;
  isolate: boolean;
  loader?: string;
}

export class StaleProtonTarget extends ProcessCanceled {
  constructor() {
    super("The active Proton profile or its installation changed. Retry this launch.");
  }
}

export interface IProtonPreparation {
  appId: string;
  profileId: string;
  gamePath: string;
  protonPath: string;
  shaderWrapper?: string;
  assertCurrent: () => void;
}

/** Exported ports let tests exercise serial work, mutations and stale guards separately. */
export interface IProtonOrchestrationPorts {
  target: (state: IState) => IProtonTarget | undefined;
  detect: typeof detectModRuntimeDependencies;
  inspect: typeof inspectPrefix;
  configured: typeof getConfiguredProtonName;
  /** Asks Steam to install one of its apps, such as Proton Experimental. */
  requestInstall: (steamAppId: string) => void;
  /** Starts a no-op program with the profile's Proton, which runs Proton's own prefix setup. */
  preparePrefix: (api: IExtensionApi, game: ISteamEntry) => Promise<void>;
  tools: typeof listInstalledProton;
  read: (file: string) => Promise<string>;
  write: (file: string, value: string) => Promise<void>;
  install: typeof installDependencies;
  resolveDependency: typeof resolveDependencyTarget;
  getLaunchOptions: typeof getSteamLaunchOptions;
  setLaunchOptions: typeof setSteamLaunchOptions;
  setCompatTool: typeof setSteamCompatTool;
  configureCache: typeof configureShaderCache;
  ensureCache: typeof ensureShaderCacheWrapper;
  checkCache: typeof checkShaderCacheWrapper;
  ensureLoader: typeof ensureGameLaunchWrapper;
  checkLoader: typeof checkGameLaunchWrapper;
  publish: typeof publishProtonSetupStatus;
}

export function currentProtonTarget(state: IState): IProtonTarget | undefined {
  const profile = activeProfile(state);
  const game = activeProtonGame(state);
  const steamPath = findLinuxSteamPath();
  if (profile === undefined || game === undefined || steamPath === undefined) return undefined;
  if (!/^[1-9][0-9]*$/.test(game.appid) || !path.isAbsolute(game.gamePath)) return undefined;
  const discovery = state.settings.gameMode.discovered[profile.gameId];
  const tools = discovery?.tools ?? {};
  const primaryId = state.settings.interface.primaryTool?.[profile.gameId];
  const primary =
    primaryId === undefined
      ? Object.values(tools).find((tool) => tool.defaultPrimary === true)
      : tools[primaryId];
  const loader =
    primary?.defaultPrimary === true &&
    typeof primary.path === "string" &&
    isWindowsExecutable(primary.path)
      ? path.resolve(game.gamePath, primary.path)
      : undefined;
  const selected =
    typeof profile.features?.["proton-version"] === "string"
      ? (profile.features["proton-version"] as string)
      : "";
  const automatic = profile.features?.["proton-auto-dependencies"] !== false;
  const isolate = profile.features?.["proton-shader-cache-isolation"] !== false;
  const key = JSON.stringify([
    profile.id,
    profile.gameId,
    game.appid,
    path.resolve(game.gamePath),
    game.compatDataPath,
    steamPath,
    selected,
    automatic,
    isolate,
    loader,
    Object.entries(profile.modState ?? {}).sort(([left], [right]) => left.localeCompare(right)),
    enabledModPaths(state, profile).sort(),
  ]);
  return { key, profile, game, steamPath, selected, automatic, isolate, loader };
}

type PrefixPreparer = (api: IExtensionApi, game: ISteamEntry) => Promise<void>;
let prefixPreparer: PrefixPreparer | undefined;

/** Steam's Proton launcher registers here, so this module needn't import (and construct) it. */
export function setProtonPrefixPreparer(preparer: PrefixPreparer): void {
  prefixPreparer = preparer;
}

const defaultPorts: IProtonOrchestrationPorts = {
  target: currentProtonTarget,
  detect: detectModRuntimeDependencies,
  inspect: inspectPrefix,
  configured: getConfiguredProtonName,
  requestInstall: (steamAppId) => window.api.shell.openUrl(`steam://install/${steamAppId}`),
  preparePrefix: async (api, game) => {
    if (prefixPreparer === undefined) throw new Error("Proton launches are unavailable");
    await prefixPreparer(api, game);
  },
  tools: listInstalledProton,
  read: (file) => fs.readFile(file, "utf8"),
  write: (file, value) => fs.writeFile(file, value),
  install: installDependencies,
  resolveDependency: resolveDependencyTarget,
  getLaunchOptions: getSteamLaunchOptions,
  setLaunchOptions: setSteamLaunchOptions,
  setCompatTool: setSteamCompatTool,
  configureCache: configureShaderCache,
  ensureCache: ensureShaderCacheWrapper,
  checkCache: checkShaderCacheWrapper,
  ensureLoader: ensureGameLaunchWrapper,
  checkLoader: checkGameLaunchWrapper,
  publish: publishProtonSetupStatus,
};

export function matchesActiveLaunch(
  target: IProtonTarget,
  executable: string,
  options: IRunOptions,
  game?: ISteamEntry,
): boolean {
  if (!isWindowsExecutable(executable)) return false;
  if (
    game !== undefined &&
    (game.appid !== target.game.appid || !isSameGamePath(game.gamePath, target.game.gamePath))
  )
    return false;
  if (options.gameId !== undefined) return options.gameId === target.profile.gameId;
  const resolved = path.isAbsolute(executable)
    ? executable
    : options.cwd !== undefined && path.isAbsolute(options.cwd)
      ? path.resolve(options.cwd, executable)
      : undefined;
  return resolved !== undefined && isPathInsideGame(resolved, target.game.gamePath);
}

export function createProtonCoordinator(
  api: IExtensionApi,
  overrides: Partial<IProtonOrchestrationPorts> = {},
) {
  const ports = { ...defaultPorts, ...overrides };
  let tail: Promise<void> = Promise.resolve();
  let previousObservedKey: string | undefined;
  let installRequested = false;

  const targetNow = () => ports.target(api.getState());
  const assertTarget = (target: IProtonTarget) => {
    if (targetNow()?.key !== target.key) throw new StaleProtonTarget();
  };
  const serialize = <T>(run: () => Promise<T>): Promise<T> => {
    const result = tail.then(run);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const report = (target: IProtonTarget, error: unknown) => {
    if (targetNow()?.key !== target.key) return;
    const message = `Steam App ID ${target.game.appid}: ${unknownToError(error).message}`;
    ports.publish({ appId: target.game.appid, phase: "error", message });
    api.showErrorNotification("Could not prepare Proton for this game", new Error(message), {
      id: "proton-setup-" + target.game.appid,
      allowReport: false,
      allowSuppress: false,
    });
  };

  /** Why the Proton at `protonPath` must not drive this game's prefix, if it must not. */
  const downgradeWarning = async (target: IProtonTarget, protonPath: string) => {
    if (target.game.compatDataPath === undefined) return undefined;
    const [script, version] = await Promise.all([
      ports.read(protonScriptPath(protonPath)).catch(() => ""),
      ports.read(path.join(target.game.compatDataPath, "version")).catch(() => ""),
    ]);
    return prefixDowngradeWarning(script, version);
  };

  /** An installed Proton that can drive this game's prefix without downgrading it. */
  const prefixCompatibleTool = async (
    target: IProtonTarget,
    tools: IInstalledProton[],
    current: string | undefined,
  ) => {
    if (target.game.compatDataPath === undefined) return undefined;
    const prefixVersion = (
      await ports.read(path.join(target.game.compatDataPath, "version")).catch(() => "")
    ).trim();
    const candidates: Array<{ tool: IInstalledProton; name: string; version?: string }> = [];
    for (const tool of tools) {
      const name = protonConfigName(tool);
      if (name === undefined) continue;
      const script = await ports.read(protonScriptPath(tool.path)).catch(() => "");
      if (script === "" || prefixDowngradeWarning(script, prefixVersion) !== undefined) continue;
      candidates.push({ tool, name, version: protonPrefixVersion(script) });
    }
    assertTarget(target);
    // Prefer the runtime Steam already uses, then the one that built the prefix.
    return (
      candidates.find((candidate) => candidate.name === current) ??
      candidates.find((candidate) => candidate.version === prefixVersion) ??
      candidates[0]
    );
  };

  const synchronizeRuntime = async (target: IProtonTarget) => {
    const tools = await ports.tools(target.steamPath);
    assertTarget(target);
    let desired =
      target.selected === ""
        ? RECOMMENDED_PROTON.configName
        : (() => {
            const selected = tools.find((tool) => tool.path === target.selected);
            return selected === undefined ? undefined : protonConfigName(selected);
          })();
    let installed =
      desired === undefined
        ? undefined
        : tools.find(
            (tool) =>
              protonConfigName(tool) === desired &&
              (target.selected === "" || tool.path === target.selected),
          );
    if (target.selected === "" && installed === undefined) {
      // Steam downloads its own default Proton; scans and Retry pick it up once it's installed.
      if (!installRequested) {
        installRequested = true;
        ports.requestInstall(RECOMMENDED_PROTON.steamAppId);
      }
      throw new Error(
        `Steam is installing ${RECOMMENDED_PROTON.label}. Vortex finishes setting up this game once the download completes; select Retry setup if it doesn't.`,
      );
    }
    if (desired === undefined || installed === undefined) {
      throw new Error(
        "The Proton version selected for this profile is no longer installed. Choose another version on the Proton page.",
      );
    }
    const perGame = await ports.configured(target.steamPath, target.game.appid);
    const current = perGame ?? (await ports.configured(target.steamPath, "0"));
    assertTarget(target);
    if (target.selected === "" && (await downgradeWarning(target, installed.path)) !== undefined) {
      // The default must not downgrade a prefix that a newer Proton built, even when Steam was
      // already switched to an older release: use an installed runtime that can drive the
      // prefix as it is.
      const compatible = await prefixCompatibleTool(target, tools, current);
      if (compatible !== undefined) {
        desired = compatible.name;
        installed = compatible.tool;
      }
    }
    assertTarget(target);
    if (current !== desired) {
      // A required version change is not best-effort: otherwise dependency repair could
      // prepare a different prefix/runtime from the game Steam will subsequently launch.
      await ports.setCompatTool(target.game.appid, desired, {
        steamPath: target.steamPath,
        gamePath: target.game.gamePath,
        assertCurrent: () => assertTarget(target),
      });
      assertTarget(target);
    }
    return installed.path;
  };

  const prepareShaderHelper = async (target: IProtonTarget) => {
    if (!target.isolate) return;
    assertTarget(target);
    await ports.ensureCache();
    assertTarget(target);
    await ports.configureCache(target.game.appid, [
      ...new Set([
        path.join(path.dirname(path.dirname(target.game.gamePath)), "shadercache"),
        path.join(target.steamPath, "steamapps", "shadercache"),
      ]),
    ]);
    assertTarget(target);
    await ports.checkCache(target.game.appid);
    assertTarget(target);
  };

  const synchronizeLaunchOptions = async (target: IProtonTarget) => {
    const current = await ports.getLaunchOptions(target.game.appid, {
      steamPath: target.steamPath,
      gamePath: target.game.gamePath,
      assertCurrent: () => assertTarget(target),
    });
    assertTarget(target);
    // Remove the old owned loader before deciding whether to add the current one.
    // This also removes it when no default-primary loader remains configured.
    let next = disableDefaultToolRedirect(current, GAME_LAUNCH_WRAPPER);
    next = target.isolate
      ? enableShaderCacheRedirect(next, target.game.appid, SHADER_CACHE_WRAPPER)
      : disableShaderCacheRedirect(next, target.game.appid, SHADER_CACHE_WRAPPER);
    if (target.loader !== undefined) {
      await ports.ensureLoader();
      assertTarget(target);
      await ports.checkLoader();
      assertTarget(target);
      next = enableDefaultToolRedirect(next, target.loader, GAME_LAUNCH_WRAPPER);
    }
    assertTarget(target);
    if (next !== current) {
      await ports.setLaunchOptions(target.game.appid, next, {
        steamPath: target.steamPath,
        gamePath: target.game.gamePath,
        assertCurrent: () => assertTarget(target),
      });
      assertTarget(target);
    }
  };

  const ensureDependencies = async (
    target: IProtonTarget,
    protonPath: string,
    manual = false,
    onProgress?: DependencyProgress,
  ) => {
    if (!target.automatic && !manual) return;
    const required = [...new Set(await ports.detect(api.getState(), target.profile))].sort();
    assertTarget(target);
    // An empty scan neither provisions Protontricks nor requires a prefix/version marker.
    if (required.length === 0) return;
    if (target.game.compatDataPath === undefined) {
      throw new Error(
        "Launch this Windows game once in Steam to initialize its Proton prefix, then refresh Games.",
      );
    }
    const prefix = target.game.compatDataPath;
    if ((await downgradeWarning(target, protonPath)) !== undefined) {
      // An older Proton only downgrades a prefix when it starts a program in it, as Steam does
      // at game launch; Protontricks drives Wine directly and would skip that step. Let the
      // selected Proton prepare the prefix first, exactly as launching the game would.
      ports.publish({
        appId: target.game.appid,
        phase: "installing",
        progress: 2,
        message: "Preparing the game's prefix for the selected Proton",
      });
      await ports.preparePrefix(api, target.game);
      assertTarget(target);
      const remaining = await downgradeWarning(target, protonPath);
      assertTarget(target);
      if (remaining !== undefined) throw new Error(remaining);
    }
    const versionPath = path.join(prefix, "version");
    const markerPath = path.join(prefix, ".vortex-dependencies-version");
    const version = (await ports.read(versionPath)).trim();
    assertTarget(target);
    if (version.length === 0)
      throw new Error(
        "The Proton prefix has no version. Launch the game once in Steam and refresh Games.",
      );
    const marker = await ports
      .read(markerPath)
      .then((value) => value.trim())
      .catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      });
    const inventory = await ports.inspect(prefix);
    assertTarget(target);
    // Runtime file presence can be Wine built-ins; only installation records establish
    // that Protontricks applied the requested recipes for this prefix version.
    const missing =
      marker !== version
        ? required
        : required.filter((verb) => !inventory.winetricks.includes(verb));
    const notificationId = "proton-dependencies-" + target.game.appid;
    let activity = false;
    const progress = (value: number, message: string) => {
      assertTarget(target);
      api.sendNotification({
        id: notificationId,
        type: "activity",
        title: "Installing Windows components",
        message,
        progress: value,
        noDismiss: true,
        allowSuppress: false,
      });
      onProgress?.(value, message);
    };
    try {
      if (missing.length > 0) {
        const dependencyTarget = await ports.resolveDependency({
          appId: target.game.appid,
          steamPath: target.steamPath,
          gamePath: target.game.gamePath,
          compatDataPath: prefix,
          protonPath,
        });
        assertTarget(target);
        activity = true;
        progress(0, "Preparing Windows dependency installation");
        await ports.install(
          api,
          target.game.appid,
          missing,
          (value, message) => progress(Math.min(value, 90), message),
          {
            assertCurrent: () => assertTarget(target),
            force: marker !== version,
            target: dependencyTarget,
          },
        );
        assertTarget(target);
        progress(95, "Verifying Windows dependency installation records");
        ports.publish({
          appId: target.game.appid,
          phase: "verifying",
          progress: 95,
          message: "Verifying Windows dependency installation records",
        });
        const verified = await ports.inspect(prefix);
        assertTarget(target);
        const unresolved = required.filter((verb) => !verified.winetricks.includes(verb));
        if (unresolved.length > 0)
          throw new Error(
            `Windows dependencies remain unverified: ${unresolved.join(", ")}. Open Protontricks for Steam App ID ${target.game.appid} and retry.`,
          );
      }
      if ((await ports.read(versionPath)).trim() !== version) {
        throw new ProcessCanceled(
          "The Proton prefix changed during dependency setup. Retry after Steam finishes updating it.",
        );
      }
      assertTarget(target);
      await ports.write(markerPath, version);
      assertTarget(target);
      if (activity) {
        progress(100, "Mod requirements installed and verified");
        api.sendNotification({
          id: "proton-dependencies-complete-" + target.game.appid,
          type: "success",
          message: "Mod requirements installed and verified",
        });
      }
    } finally {
      if (activity) api.dismissNotification?.(notificationId);
    }
  };

  const reconcile = async (target: IProtonTarget, directLaunch: boolean) => {
    assertTarget(target);
    ports.publish({
      appId: target.game.appid,
      phase: "checking",
      progress: 0,
      message: "Checking Proton and enabled mods",
    });
    const protonPath = await synchronizeRuntime(target);
    await prepareShaderHelper(target);
    let settingsError: unknown;
    try {
      await synchronizeLaunchOptions(target);
    } catch (error) {
      assertTarget(target);
      settingsError = error;
    }
    await ensureDependencies(target, protonPath);
    assertTarget(target);
    if (settingsError !== undefined) {
      const error = new Error(
        `Steam launch settings could not be synchronized. Start Steam with its settings service available, then refresh the Proton page. ${unknownToError(settingsError).message}`,
      );
      report(target, error);
      // Vortex's direct command does not consume Steam launch options. Its runtime,
      // dependency and private-cache preparation have already succeeded, so a CDP
      // read failure alone must not prevent this otherwise valid direct launch.
      if (!directLaunch) return protonPath;
    } else {
      api.dismissNotification?.("proton-setup-" + target.game.appid);
      ports.publish({
        appId: target.game.appid,
        phase: "ready",
        progress: 100,
        message: "Proton setup is ready",
      });
    }
    return protonPath;
  };

  const request = (): Promise<void> =>
    serialize(async () => {
      const target = targetNow();
      if (target === undefined) return;
      try {
        await reconcile(target, false);
      } catch (error) {
        report(target, error);
      }
    });

  return {
    request,
    installManually: (expectedKey: string, onProgress?: DependencyProgress): Promise<void> => {
      const target = targetNow();
      if (target === undefined || target.key !== expectedKey)
        return Promise.reject(new StaleProtonTarget());
      return serialize(async () => {
        try {
          assertTarget(target);
          const protonPath = await synchronizeRuntime(target);
          await ensureDependencies(target, protonPath, true, onProgress);
          assertTarget(target);
          api.dismissNotification?.("proton-setup-" + target.game.appid);
          ports.publish({
            appId: target.game.appid,
            phase: "ready",
            progress: 100,
            message: "Windows dependencies are ready",
          });
        } catch (error) {
          report(target, error);
          throw error;
        }
      });
    },
    observe: () => {
      const key = targetNow()?.key;
      if (key === previousObservedKey) return;
      previousObservedKey = key;
      void request();
    },
    prepareLaunch: (
      game: ISteamEntry | undefined,
      executable: string,
      options: IRunOptions,
    ): Promise<IProtonPreparation | undefined> => {
      const target = targetNow();
      if (target === undefined || !matchesActiveLaunch(target, executable, options, game)) {
        return Promise.resolve(undefined);
      }
      return serialize(async () => {
        try {
          assertTarget(target);
          const protonPath = await reconcile(target, true);
          assertTarget(target);
          return {
            appId: target.game.appid,
            profileId: target.profile.id,
            gamePath: target.game.gamePath,
            protonPath,
            shaderWrapper: target.isolate ? SHADER_CACHE_WRAPPER : undefined,
            assertCurrent: () => assertTarget(target),
          };
        } catch (error) {
          report(target, error);
          throw error;
        }
      });
    },
    hook: async (input: IRunParameters): Promise<IRunParameters> => {
      // Native commands (including Proton and our wrappers) never recurse here.
      // The Steam pre-conversion call is still required for current ordinary launches.
      const target = targetNow();
      if (target !== undefined && matchesActiveLaunch(target, input.executable, input.options)) {
        await serialize(() => reconcile(target, true));
      }
      return input;
    },
  };
}

const coordinators = new WeakMap<IExtensionApi, ReturnType<typeof createProtonCoordinator>>();

export function protonCoordinator(api: IExtensionApi) {
  let coordinator = coordinators.get(api);
  if (coordinator === undefined) {
    coordinator = createProtonCoordinator(api);
    coordinators.set(api, coordinator);
  }
  return coordinator;
}

export function prepareProtonLaunch(
  api: IExtensionApi,
  game: ISteamEntry,
  executable: string,
  options: IRunOptions,
): Promise<IProtonPreparation | undefined> {
  return protonCoordinator(api).prepareLaunch(game, executable, options);
}
