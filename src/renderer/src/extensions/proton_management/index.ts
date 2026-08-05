import * as fs from "fs/promises";
import * as path from "path";

import { unknownToError } from "@vortex/shared";

import type { IExtensionContext } from "@/types/IExtensionContext";
import GameStoreHelper from "@/util/GameStoreHelper";
import {
  findLatestStableProtonName,
  getCompatDataPath,
  getConfiguredProtonName,
  inspectPrefix,
  isWindowsExecutable,
  protonConfigName,
} from "@/util/linux/proton";
import type { ISteamEntry, Steam } from "@/util/Steam";

import { activeGameId, activeProfile } from "../profile_management/selectors";
import { installDependencies } from "./dependencyInstaller";
import { detectModRuntimeDependencies } from "./modRequirements";
import { publishProtonSetupStatus } from "./setupStatus";
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
  publishProtonSetupStatus({
    appId: entry.appid,
    message: "Checking enabled mods",
    phase: "checking",
    progress: 0,
  });
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
  if (missing.length > 0) {
    await installDependencies(context.api, entry.appid, missing);
    publishProtonSetupStatus({
      appId: entry.appid,
      message: "Verifying installed components",
      phase: "verifying",
      progress: 95,
    });
    const verified = await inspectPrefix(compatDataPath);
    const unresolved = verbs.filter((verb) => !verified.components.includes(verb));
    if (unresolved.length > 0) {
      throw new Error(`Components were not installed correctly: ${unresolved.join(", ")}`);
    }
  }
  await fs.writeFile(path.join(compatDataPath, ".vortex-dependencies-version"), protonVersion);
  publishProtonSetupStatus({
    appId: entry.appid,
    message: "Proton setup is ready",
    phase: "ready",
    progress: 100,
  });
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
  const configured = await getConfiguredProtonName(steamPath, entry.appid);
  const selectedPath = profile.features?.["proton-version"];
  const selectedName =
    typeof selectedPath === "string" && selectedPath.length > 0
      ? protonConfigName({
          id: selectedPath,
          name: path.basename(selectedPath),
          path: selectedPath,
          source: selectedPath.startsWith(path.join(steamPath, "compatibilitytools.d"))
            ? "custom"
            : "steam",
        })
      : await findLatestStableProtonName(steamPath);
  if (selectedName !== undefined && configured !== selectedName) {
    await setSteamCompatTool(entry.appid, selectedName);
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
    if (missing.length > 0) {
      await installDependencies(context.api, entry.appid, missing);
      const verified = await inspectPrefix(compatDataPath);
      const unresolved = verbs.filter((verb) => !verified.components.includes(verb));
      if (unresolved.length > 0) {
        throw new Error(`Components were not installed correctly: ${unresolved.join(", ")}`);
      }
    }
    return input;
  });
  context.once(() => {
    const reconcile = () => {
      if (reconciliation === undefined) {
        // Steam must select the profile's Proton before Protontricks opens or repairs that prefix.
        // Keeping this ordered makes the page's single selected version authoritative end to end.
        reconciliation = ensureActiveProfileCacheIsolation(context)
          .then(() => ensureActiveProfileDependencies(context))
          .catch((err) => {
            const message = unknownToError(err).message;
            publishProtonSetupStatus({ message, phase: "error" });
            context.api.showErrorNotification("Failed to prepare Proton for this game", err);
          })
          .finally(() => {
            reconciliation = undefined;
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
