import * as fs from "fs/promises";
import * as path from "path";

import { unknownToError } from "@vortex/shared";
import { ProcessCanceled } from "@vortex/shared/errors";

import { getGame } from "@/extensions/gamemode_management/util/getGame";
import type { IExtensionApi, IRunParameters, IRunOptions } from "@/types/IExtensionContext";
import type { IState } from "@/types/IState";
import { isPathInsideGame, isSameGamePath } from "@/util/linux/gamePath";
import {
  getConfiguredProtonName,
  inspectPrefix,
  isWindowsExecutable,
  listInstalledProton,
  prefixDowngradeWarning,
  protonScriptPath,
  resolveSteamProton,
  steamProtonLabel,
} from "@/util/linux/proton";
import { resolveDependencyTarget } from "@/util/linux/protonMetadata";
import {
  parseSteamLaunchOptions,
  readSteamLaunchOptions,
  type ISteamLaunchOptions,
} from "@/util/linux/steamLaunchOptions";
import { findLinuxSteamPath } from "@/util/linux/steamPaths";
import { log } from "@/util/log";
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
  disableDefaultToolRedirect,
  disableShaderCacheRedirect,
  ensureShaderCacheWrapper,
  GAME_LAUNCH_WRAPPER,
  SHADER_CACHE_WRAPPER,
} from "./steamShaderSettings";

export interface IProtonTarget {
  key: string;
  profile: IProfile;
  game: ISteamEntry;
  steamPath: string;
  automatic: boolean;
  isolate: boolean;
  loader?: string;
  /** The game's own executable, which Steam applies the game's launch options to. */
  executable?: string;
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
  /** The user's Steam launch options, when this launch starts the game itself. */
  launchOptions?: ISteamLaunchOptions;
  assertCurrent: () => void;
}

/** Exported ports let tests exercise serial work, mutations and stale guards separately. */
export interface IProtonOrchestrationPorts {
  target: (state: IState) => IProtonTarget | undefined;
  detect: typeof detectModRuntimeDependencies;
  inspect: typeof inspectPrefix;
  configured: typeof getConfiguredProtonName;
  /** Starts a no-op program with Steam's Proton, which runs Proton's own prefix setup. */
  preparePrefix: (api: IExtensionApi, game: ISteamEntry) => Promise<void>;
  tools: typeof listInstalledProton;
  read: (file: string) => Promise<string>;
  write: (file: string, value: string) => Promise<void>;
  install: typeof installDependencies;
  resolveDependency: typeof resolveDependencyTarget;
  /** Reads the launch options Steam saved for a game; Vortex never changes them. */
  getLaunchOptions: typeof readSteamLaunchOptions;
  configureCache: typeof configureShaderCache;
  ensureCache: typeof ensureShaderCacheWrapper;
  checkCache: typeof checkShaderCacheWrapper;
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
  let executable: string | undefined;
  try {
    const relative = discovery?.executable ?? getGame(profile.gameId)?.executable(discovery?.path);
    if (typeof relative === "string" && isWindowsExecutable(relative))
      executable = path.resolve(game.gamePath, relative);
  } catch {
    // A game support that cannot name its executable leaves launch options to Steam.
  }
  const automatic = profile.features?.["proton-auto-dependencies"] !== false;
  const isolate = profile.features?.["proton-shader-cache-isolation"] !== false;
  const key = JSON.stringify([
    profile.id,
    profile.gameId,
    game.appid,
    path.resolve(game.gamePath),
    game.compatDataPath,
    steamPath,
    automatic,
    isolate,
    loader,
    Object.entries(profile.modState ?? {}).sort(([left], [right]) => left.localeCompare(right)),
    enabledModPaths(state, profile).sort(),
  ]);
  return { key, profile, game, steamPath, automatic, isolate, loader, executable };
}

/**
 * The user's Steam launch options for a launch that starts the game itself (its executable or
 * its default loader), as Steam would apply them. Other tools in the game folder never receive
 * them. Options that need a shell are left out, with a log entry.
 */
function gameLaunchOptions(
  target: IProtonTarget,
  executable: string,
  userOptions: string | undefined,
): ISteamLaunchOptions | undefined {
  if (userOptions === undefined) return undefined;
  const launched = path.resolve(target.game.gamePath, executable);
  const startsGame = [target.executable, target.loader].some(
    (candidate) => candidate !== undefined && isSameGamePath(candidate, launched),
  );
  if (!startsGame) return undefined;
  const parsed = parseSteamLaunchOptions(userOptions);
  if (parsed === undefined)
    log("warn", "Steam launch options need a shell, so Vortex's direct launch leaves them out", {
      appId: target.game.appid,
    });
  return parsed;
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
  preparePrefix: async (api, game) => {
    if (prefixPreparer === undefined) throw new Error("Proton launches are unavailable");
    await prefixPreparer(api, game);
  },
  tools: listInstalledProton,
  read: (file) => fs.readFile(file, "utf8"),
  write: (file, value) => fs.writeFile(file, value),
  install: installDependencies,
  resolveDependency: resolveDependencyTarget,
  getLaunchOptions: readSteamLaunchOptions,
  configureCache: configureShaderCache,
  ensureCache: ensureShaderCacheWrapper,
  checkCache: checkShaderCacheWrapper,
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
    const message = unknownToError(error).message;
    // The Proton page already belongs to this game; notifications can come from any page.
    ports.publish({ appId: target.game.appid, phase: "error", message });
    api.showErrorNotification(
      "Could not prepare Proton for this game",
      new Error(`Steam App ID ${target.game.appid}: ${message}`),
      {
        id: "proton-setup-" + target.game.appid,
        allowReport: false,
        allowSuppress: false,
      },
    );
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

  /** The Proton Steam runs this game with. Vortex follows Steam and never changes it. */
  const steamRuntime = async (target: IProtonTarget) => {
    const tools = await ports.tools(target.steamPath);
    assertTarget(target);
    const choice = await resolveSteamProton(
      target.steamPath,
      target.game.appid,
      target.game.compatDataPath,
      tools,
      { configured: ports.configured, read: ports.read },
    );
    assertTarget(target);
    if (choice.tool !== undefined) return choice.tool.path;
    throw new Error(
      choice.name === undefined
        ? "No Proton is installed. Launch the game once from Steam so Steam installs Proton, then refresh."
        : `Steam runs this game with ${steamProtonLabel(choice.name)}, which isn't installed. Launch the game once from Steam so Steam downloads it. To use another version, open the game's Properties in Steam and choose Compatibility.`,
    );
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

  /**
   * The user's own Steam launch options, read from Steam's files. Redirects that earlier Vortex
   * builds added to them are left out, since Vortex applies its own cache wrapper directly.
   */
  const userLaunchOptions = async (target: IProtonTarget): Promise<string | undefined> => {
    try {
      const saved = await ports.getLaunchOptions(target.steamPath, target.game.appid);
      assertTarget(target);
      return disableShaderCacheRedirect(
        disableDefaultToolRedirect(saved, GAME_LAUNCH_WRAPPER),
        target.game.appid,
        SHADER_CACHE_WRAPPER,
      );
    } catch (error) {
      assertTarget(target);
      // Steam settings that can't be read leave the launch as Steam's plain command.
      log("warn", "Could not read Steam launch options", {
        appId: target.game.appid,
        error: unknownToError(error).message,
      });
      return undefined;
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
      // at game launch; Protontricks drives Wine directly and would skip that step. Let
      // Steam's Proton prepare the prefix first, exactly as launching the game would.
      ports.publish({
        appId: target.game.appid,
        phase: "installing",
        progress: 2,
        message: "Preparing the game's prefix for Steam's Proton",
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

  const reconcile = async (target: IProtonTarget) => {
    assertTarget(target);
    ports.publish({
      appId: target.game.appid,
      phase: "checking",
      progress: 0,
      message: "Checking Proton and enabled mods",
    });
    const protonPath = await steamRuntime(target);
    await prepareShaderHelper(target);
    const userOptions = await userLaunchOptions(target);
    await ensureDependencies(target, protonPath);
    assertTarget(target);
    api.dismissNotification?.("proton-setup-" + target.game.appid);
    ports.publish({
      appId: target.game.appid,
      phase: "ready",
      progress: 100,
      message: "Proton setup is ready",
    });
    return { protonPath, userOptions };
  };
  const request = (): Promise<void> =>
    serialize(async () => {
      const target = targetNow();
      if (target === undefined) return;
      try {
        await reconcile(target);
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
          const protonPath = await steamRuntime(target);
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
          const { protonPath, userOptions } = await reconcile(target);
          assertTarget(target);
          return {
            appId: target.game.appid,
            profileId: target.profile.id,
            gamePath: target.game.gamePath,
            protonPath,
            shaderWrapper: target.isolate ? SHADER_CACHE_WRAPPER : undefined,
            launchOptions: gameLaunchOptions(target, executable, userOptions),
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
        await serialize(() => reconcile(target));
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
