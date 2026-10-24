import * as path from "path";

import type { IExtensionContext } from "../../types/IExtensionContext";
import { activeGameId } from "../../util/selectors";
import { clearDeletions } from "../../util/vfsFsView";
import type { IDeploymentMethod } from "../mod_management/types/IDeploymentMethod";
import { isMounted, mountGame, mountsApply, unmountAll, unmountGame } from "./mounts";
import { isVirtualGame, showOverwriteDialog } from "./overwrite";
import { cleanStaleSessions, launchesDirectly, makeLaunchRunner } from "./runner";
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
      // Running programs of the game follow the view (runner.ts).
      deployed: (gameId, dataPath, stagingPath, files) => {
        // A deploy restores what it deploys, as relinking did: deletions over its files go.
        clearDeletions(files.map((file) => path.join(dataPath, file.target ?? "", file.relPath)));
        showDeployment(api.getState(), gameId, dataPath, stagingPath, files);
      },
      purged: (gameId, dataPath) => {
        const id = gameId ?? activeGameId(api.getState());
        if (id !== undefined) {
          hideDeployment(api.getState(), id, dataPath);
        }
      },
    }),
  );
  // Before the default spawn; no other runner is registered in core.
  context.registerLaunchRunner(100, "aether-vfs", makeLaunchRunner(api));
  // A store launcher (Steam, Epic, GOG) would start the game outside the session: the game is
  // started directly instead, with its store identity (runner.ts). StarterInfo asks.
  context.registerAPI("vfsLaunchesDirectly", (gameId: string) => launchesDirectly(api, gameId), {
    minArguments: 1,
  });
  // What games and tools wrote into the game folder lives apart from it (overwrite.ts).
  context.registerAction(
    "mod-icons",
    118,
    "folder-download",
    {},
    "Generated files",
    () => {
      void showOverwriteDialog(api);
    },
    () => isVirtualGame(api, activeGameId(api.getState())),
  );
  context.once(() => {
    cleanStaleSessions();
    const show = (gameId: string | undefined) => {
      if (gameId !== undefined) {
        void showGameFromManifests(api, gameId);
      }
    };
    show(activeGameId(api.getState()));
    api.events.on("gamemode-activated", show);

    if (mountsApply()) {
      // Linux: the game's folders are mounted while Vortex runs (mounts.ts).
      const gameOf = (profileId: string): string | undefined =>
        api.getState().persistent.profiles[profileId]?.gameId;
      const mount = (gameId: string | undefined) => {
        if (gameId !== undefined && isVirtualGame(api, gameId) && !isMounted(gameId)) {
          void mountGame(api, gameId);
        }
      };
      api.onAsync("will-deploy", (profileId: string) => {
        const gameId = gameOf(profileId);
        if (gameId !== undefined) unmountGame(gameId);
        return Promise.resolve();
      });
      api.onAsync("did-deploy", async (profileId: string) => {
        const gameId = gameOf(profileId);
        if (gameId !== undefined && isVirtualGame(api, gameId)) await mountGame(api, gameId);
      });
      api.onAsync("will-purge", (profileId: string) => {
        const gameId = gameOf(profileId);
        if (gameId !== undefined) unmountGame(gameId);
        return Promise.resolve();
      });
      mount(activeGameId(api.getState()));
      api.events.on("gamemode-activated", mount);
      window.addEventListener("beforeunload", () => unmountAll());
    }
  });
  return true;
}

export default init;
