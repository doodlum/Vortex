import path from "path";

import { log, selectors } from "@nexusmods/vortex-api";
import type { types } from "@nexusmods/vortex-api";
import { getErrorMessageOrDefault } from "@vortex/shared";
/**
 * Registers runtime event handlers used by the Stardew Valley extension.
 */
import type { IQuery, IServer } from "modmeta-db";

import { GAME_ID, MOD_TYPE_SMAPI } from "../common";
import { updateConflictInfo } from "../compatibility/updateConflictInfo";
import { onAddedFiles, onWillEnableMods } from "../configMod";
import { SMAPIProxy } from "../smapi/proxy";
import { refreshSMAPIState } from "../smapi/status";

type LoopbackCB = NonNullable<IServer["loopbackCB"]>;

/**
 * Registers long-lived runtime handlers that should run once the extension is
 * fully initialised.
 *
 * This owns:
 * - SMAPI metadata server registration
 * - deployment/purge hooks
 * - file ingestion hooks
 * - compatibility refresh hooks
 */
export function registerRuntimeEvents(context: types.IExtensionContext) {
  context.once(() => {
    const store = context.api.store;
    if (store === undefined) {
      log("error", "stardewvalley failed to initialize runtime: redux store unavailable");
      return;
    }

    const proxy = new SMAPIProxy(context.api);
    const loopbackCB: LoopbackCB = ((query: IQuery) =>
      proxy.find(query).catch((err) => {
        log("error", "failed to look up smapi meta info", getErrorMessageOrDefault(err));
        return [];
      })) as unknown as LoopbackCB;

    context.api.setStylesheet("sdv", path.join(__dirname, "ui", "sdvstyle.scss"));

    context.api.addMetaServer("smapi.io", {
      url: "",
      loopbackCB,
      cacheDurationSec: 86400,
      priority: 25,
    });

    context.api.onAsync(
      "added-files",
      (profileId: string, files: any[]) => onAddedFiles(context.api, profileId, files) as any,
    );

    context.api.onAsync(
      "will-enable-mods",
      (profileId: string, modIds: string[], enabled: boolean, options: any) =>
        onWillEnableMods(context.api, profileId, modIds, enabled, options) as any,
    );

    context.api.onAsync("did-deploy", async (profileId: string) => {
      const state = context.api.getState();
      const profile = selectors.profileById(state, profileId);
      if (profile?.gameId !== GAME_ID) {
        return;
      }

      await refreshSMAPIState(context.api, { profileId });
    });

    context.api.onAsync("did-purge", async (profileId: string) => {
      const profile = selectors.profileById(context.api.getState(), profileId);
      if (profile?.gameId !== GAME_ID) return;
      await refreshSMAPIState(context.api, { profileId });
    });

    context.api.onAsync("did-remove-mods", async (gameId: string) => {
      if (gameId !== GAME_ID) return;
      // Removal completion also fires after failure: read the current mod/file
      // state rather than assuming the requested packages were removed.
      await refreshSMAPIState(context.api);
    });

    context.api.events.on("did-install-mod", (gameId: string, archiveId: string, modId: string) => {
      if (gameId !== GAME_ID) {
        return;
      }
      if (context.api.getState().persistent.mods[gameId]?.[modId]?.type === MOD_TYPE_SMAPI) {
        refreshSMAPIState(context.api).catch((err) =>
          log("error", "failed to refresh SMAPI status", { error: getErrorMessageOrDefault(err) }),
        );
      }
      updateConflictInfo(context.api, proxy, gameId, modId)
        .then(() => log("debug", "added compatibility info", { modId }))
        .catch((err) =>
          log("error", "failed to add compatibility info", {
            modId,
            error: getErrorMessageOrDefault(err),
          }),
        );
    });

    context.api.events.on("gamemode-activated", (gameMode: string) => {
      if (gameMode !== GAME_ID) {
        return;
      }

      const state = context.api.getState();
      log("debug", "updating SDV compatibility info");
      Promise.all(
        Object.keys(state.persistent.mods[gameMode] ?? {}).map((modId) =>
          updateConflictInfo(context.api, proxy, gameMode, modId),
        ),
      )
        .then(() => {
          log("debug", "done updating compatibility info");
        })
        .catch((err) => {
          log("error", "failed to update conflict info", getErrorMessageOrDefault(err));
        });
    });
  });
}
