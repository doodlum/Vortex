import * as fs from "fs/promises";
import * as path from "path";

import type { IExtensionContext } from "@/types/IExtensionContext";
import GameStoreHelper from "@/util/GameStoreHelper";
import {
  findLatestStableProtonName,
  getCompatDataPath,
  getConfiguredProtonName,
  inspectPrefix,
  isWindowsExecutable,
} from "@/util/linux/proton";
import type { ISteamEntry, Steam } from "@/util/Steam";

import { activeGameId, activeProfile } from "../profile_management/selectors";
import { installDependencies } from "./dependencyInstaller";
import { detectModRuntimeDependencies } from "./modRequirements";
import {
  enableDefaultToolRedirect,
  enableShaderCacheRedirect,
  ensureGameLaunchWrapper,
  GAME_LAUNCH_WRAPPER,
  getSteamLaunchOptions,
  setSteamCompatTool,
  setSteamLaunchOptions,
  SHADER_CACHE_WRAPPER,
} from "./steamShaderSettings";
import { ProtonPage } from "./views/ProtonPage";

let reconciliation: Promise<void> | undefined;
let cacheReconciliation: Promise<void> | undefined;

async function prefixDependencyVersion(compatDataPath: string): Promise<string> {
  return fs.readFile(path.join(compatDataPath, "version"), "utf8").then((value) => value.trim());
}

async function installedDependencyVersion(compatDataPath: string): Promise<string | undefined> {
  try {
    const value = await fs.readFile(
      path.join(compatDataPath, ".vortex-dependencies-version"),
      "utf8",
    );
    return value.trim();
  } catch {
    return undefined;
  }
}

async function ensureActiveProfileDependencies(context: IExtensionContext): Promise<void> {
  const profile = activeProfile(context.api.getState());
  if (profile === undefined || profile.features?.["proton-auto-dependencies"] === false) return;
  const discovery = context.api.getState().settings.gameMode.discovered[profile.gameId];
  if (discovery?.path === undefined) return;
  const steam = GameStoreHelper.getGameStore("steam") as Steam;
  const games = await steam.allGames();
  const entry = games.find((game) =>
    discovery.path.toLowerCase().startsWith(game.gamePath.toLowerCase()),
  );
  if (entry === undefined) return;
  const steamAppsPath = path.dirname(path.dirname(entry.gamePath));
  const compatDataPath = entry.compatDataPath ?? getCompatDataPath(steamAppsPath, entry.appid);
  const required = detectModRuntimeDependencies(context.api.getState(), profile);
  const [verbs, inventory, protonVersion, dependencyVersion] = await Promise.all([
    required,
    inspectPrefix(compatDataPath),
    prefixDependencyVersion(compatDataPath),
    installedDependencyVersion(compatDataPath),
  ]);
  const prefixChanged = dependencyVersion !== protonVersion;
  const missing = prefixChanged
    ? verbs
    : verbs.filter((verb) => !inventory.components.includes(verb));
  if (missing.length > 0) await installDependencies(context.api, entry.appid, missing);
  await fs.writeFile(path.join(compatDataPath, ".vortex-dependencies-version"), protonVersion);
}

async function ensureActiveProfileCacheIsolation(context: IExtensionContext): Promise<void> {
  const profile = activeProfile(context.api.getState());
  if (profile === undefined) return;
  const discovery = context.api.getState().settings.gameMode.discovered[profile.gameId];
  if (discovery?.path === undefined) return;
  const steam = GameStoreHelper.getGameStore("steam") as Steam;
  const games = await steam.allGames();
  const entry = games.find((game) =>
    discovery.path.toLowerCase().startsWith(game.gamePath.toLowerCase()),
  );
  if (entry === undefined) return;
  const steamAppsPath = path.dirname(path.dirname(entry.gamePath));
  const steamPath = path.dirname(steamAppsPath);
  if ((await getConfiguredProtonName(steamPath, entry.appid)) === undefined) {
    const latestStable = await findLatestStableProtonName(steamPath);
    if (latestStable !== undefined) await setSteamCompatTool(entry.appid, latestStable);
  }
  const current = await getSteamLaunchOptions(entry.appid);
  let next =
    profile.features?.["proton-shader-cache-isolation"] === false
      ? current
      : enableShaderCacheRedirect(current, entry.appid, SHADER_CACHE_WRAPPER);
  const state = context.api.getState();
  const tools = state.settings.gameMode.discovered[profile.gameId]?.tools ?? {};
  const configuredPrimary = state.settings.interface?.primaryTool?.[profile.gameId];
  const defaultTool = Object.values(tools).find((tool) => tool?.defaultPrimary === true);
  const primaryTool = configuredPrimary === undefined ? defaultTool : tools[configuredPrimary];
  if (primaryTool?.defaultPrimary === true && primaryTool.path !== undefined) {
    await ensureGameLaunchWrapper();
    next = enableDefaultToolRedirect(next, primaryTool.path, GAME_LAUNCH_WRAPPER);
  }
  if (next !== current) await setSteamLaunchOptions(entry.appid, next);
}

function init(context: IExtensionContext): boolean {
  context.registerMainPage("proton", "Proton", ProtonPage, {
    priority: 55,
    group: "per-game",
    newLayout: true,
    visible: () =>
      process.platform === "linux" && activeGameId(context.api.getState()) !== undefined,
    props: () => ({ api: context.api }),
  });
  context.registerStartHook(80, "proton-dependencies", async (input) => {
    if (process.platform === "win32" || !isWindowsExecutable(input.executable)) return input;
    const profile = activeProfile(context.api.getState());
    if (profile === undefined || profile.features?.["proton-auto-dependencies"] === false)
      return input;
    const steam = GameStoreHelper.getGameStore("steam") as Steam;
    const games = await steam.allGames();
    const executable = input.executable.toLowerCase();
    const entry: ISteamEntry | undefined = games.find((game) =>
      executable.startsWith(game.gamePath.toLowerCase()),
    );
    if (entry === undefined) return input;
    const steamAppsPath = path.dirname(path.dirname(entry.gamePath));
    const compatDataPath = entry.compatDataPath ?? getCompatDataPath(steamAppsPath, entry.appid);
    const required = detectModRuntimeDependencies(context.api.getState(), profile);
    const [verbs, inventory] = await Promise.all([required, inspectPrefix(compatDataPath)]);
    const missing = verbs.filter((verb) => !inventory.components.includes(verb));
    if (missing.length > 0) await installDependencies(context.api, entry.appid, missing);
    return input;
  });
  context.once(() => {
    const reconcile = () => {
      if (reconciliation === undefined) {
        reconciliation = ensureActiveProfileDependencies(context)
          .catch((err) =>
            context.api.showErrorNotification("Failed to satisfy Windows dependencies", err),
          )
          .finally(() => {
            reconciliation = undefined;
          });
      }
      if (cacheReconciliation === undefined) {
        cacheReconciliation = ensureActiveProfileCacheIsolation(context)
          .catch((err) =>
            context.api.showErrorNotification("Failed to enable shader-cache isolation", err),
          )
          .finally(() => {
            cacheReconciliation = undefined;
          });
      }
    };
    context.api.events.on("profile-did-change", reconcile);
    context.api.events.on("did-deploy", reconcile);
    reconcile();
  });
  return true;
}

export default init;
