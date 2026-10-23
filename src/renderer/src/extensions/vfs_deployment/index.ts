import type { IExtensionContext } from "../../types/IExtensionContext";
import type { IDeploymentMethod } from "../mod_management/types/IDeploymentMethod";
import { makeLaunchRunner } from "./runner";
import { vfsSupport } from "./support";
import VirtualDeployment from "./VirtualDeployment";

export interface IExtensionContextEx extends IExtensionContext {
  registerDeploymentMethod: (activator: IDeploymentMethod) => void;
}

/**
 * Deployment through the aether-vfs virtual file system: mods are recorded, not linked, and
 * every Windows program Vortex starts for the game runs in a session that shows the game
 * folder with them. See docs/aether-vfs-deployment.md.
 */
function init(context: IExtensionContextEx): boolean {
  context.registerDeploymentMethod(
    new VirtualDeployment((state, gameId) => vfsSupport(state, gameId)),
  );
  // Before the default spawn; no other runner is registered in core.
  context.registerLaunchRunner(100, "aether-vfs", makeLaunchRunner(context.api));
  return true;
}

export default init;
