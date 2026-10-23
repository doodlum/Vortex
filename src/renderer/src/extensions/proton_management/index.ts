import type { IExtensionContext } from "@/types/IExtensionContext";
import { subscribeSteamGamesChanged } from "@/util/linux/steamRevision";

import { protonCoordinator } from "./orchestration";
import { activeProtonGame } from "./selection";
import { ProtonPage } from "./views/ProtonPage";

function init(context: IExtensionContext): boolean {
  if (process.platform !== "linux") return true;
  context.registerMainPage("proton", "Proton", ProtonPage, {
    priority: 55,
    group: "per-game",
    newLayout: true,
    menuIcon: "science",
    visible: () => activeProtonGame(context.api.getState()) !== undefined,
    props: () => ({ api: context.api }),
  });
  const coordinator = protonCoordinator(context.api);
  context.registerStartHook(80, "proton-dependencies", coordinator.hook);
  context.once(() => {
    const observe = () => coordinator.observe();
    const refresh = () => {
      void coordinator.request();
    };
    context.api.events.on("profile-did-change", refresh);
    context.api.events.on("did-deploy", refresh);
    context.api.onStateChange?.(["settings", "profiles", "activeProfileId"], observe);
    context.api.onStateChange?.(["persistent", "profiles"], observe);
    context.api.onStateChange?.(["persistent", "mods"], observe);
    context.api.onStateChange?.(["settings", "gameMode", "discovered"], observe);
    context.api.onStateChange?.(["settings", "interface", "primaryTool"], observe);
    // First Steam registration/scan is outside Redux. Keeping only profile/deploy
    // subscriptions loses initial setup if those events happen before Steam is ready.
    subscribeSteamGamesChanged(refresh);
    refresh();
  });
  return true;
}

export default init;
