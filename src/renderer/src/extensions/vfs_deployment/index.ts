import type { IExtensionContext } from "../../types/IExtensionContext";
import { activeGameId } from "../../util/selectors";
import type { IDeploymentMethod } from "../mod_management/types/IDeploymentMethod";
import { makeLaunchRunner } from "./runner";
import { vfsSupport } from "./support";
import { hideDeployment, showDeployment, showGameFromManifests } from "./view";
import VirtualDeployment from "./VirtualDeployment";

export interface IExtensionContextEx extends IExtensionContext {
  registerDeploymentMethod: (activator: IDeploymentMethod) => void;
}

/**
 * Deployment through the aether-vfs virtual file system: mods are recorded, not linked, and
 * every Windows program Vortex starts for the game runs in a session that shows the game
 * folder with them. Vortex's own file reads see the same folder (`util/vfsFsView`). See
 * docs/aether-vfs-deployment.md.
 */
function init(context: IExtensionContextEx): boolean {
  const api = context.api;
  context.registerDeploymentMethod(
    new VirtualDeployment((state, gameId) => vfsSupport(state, gameId), {
      deployed: (gameId, dataPath, stagingPath, files) =>
        showDeployment(api.getState(), gameId, dataPath, stagingPath, files),
      purged: (gameId, dataPath) =>
        hideDeployment(gameId ?? activeGameId(api.getState()), dataPath),
    }),
  );
  // Before the default spawn; no other runner is registered in core.
  context.registerLaunchRunner(100, "aether-vfs", makeLaunchRunner(api));
  context.once(() => {
    const show = (gameId: string | undefined) => {
      if (gameId !== undefined) {
        void showGameFromManifests(api, gameId);
      }
    };
    show(activeGameId(api.getState()));
    api.events.on("gamemode-activated", show);
  });
  return true;
}

export default init;
