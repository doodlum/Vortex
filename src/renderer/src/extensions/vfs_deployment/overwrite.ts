import * as path from "path";

import type { IExtensionApi } from "../../types/IExtensionContext";
import * as fs from "../../util/fs";
import { log } from "../../util/log";
import opn from "../../util/opn";
import { activeGameId, activeProfile, installPathForGame } from "../../util/selectors";
import {
  isModFile,
  type IOverwriteEntry,
  overwriteEntriesUnder,
  rescanOverwrites,
} from "../../util/vfsFsView";
import { getGame } from "../gamemode_management/util/getGame";
import type { IMod } from "../mod_management/types/IMod";
import { getCurrentActivator } from "../mod_management/util/deploymentMethods";
import { setModEnabled } from "../profile_management/actions/profiles";
import { OVERWRITE_FOLDER } from "./roots";
import { VFS_DEPLOYMENT_ID } from "./VirtualDeployment";

/**
 * What games and tools wrote into the folders of a game deployed through the virtual file
 * system. It lands in the write folders under staging (`OVERWRITE_FOLDER`), never in the game
 * folder: files they made, changes to mods' files (which External Changes offers to import or
 * revert) and deletions.
 */
export interface IOverwriteSummary {
  gamePath: string;
  /** The default mod type's folder (the game's `Data`), where a mod's files are relative to. */
  modPath: string;
  folder: string;
  /** Files programs made, under the mod folder: what a mod can be made from. */
  made: IOverwriteEntry[];
  /** Files programs made elsewhere in the game folder. */
  madeElsewhere: IOverwriteEntry[];
  changed: number;
  deleted: number;
}

export function isVirtualGame(api: IExtensionApi, gameId: string | undefined): boolean {
  return (
    gameId !== undefined &&
    getCurrentActivator(api.getState(), gameId, true)?.id === VFS_DEPLOYMENT_ID
  );
}

export function overwriteSummary(
  api: IExtensionApi,
  gameId: string,
): IOverwriteSummary | undefined {
  const state = api.getState();
  const gamePath = state.settings.gameMode.discovered[gameId]?.path;
  const game = getGame(gameId);
  const stagingPath = installPathForGame(state, gameId);
  if (gamePath === undefined || game === undefined || stagingPath === undefined) {
    return undefined;
  }
  rescanOverwrites();
  const modPath = game.getModPaths(gamePath)[""] ?? gamePath;
  const summary: IOverwriteSummary = {
    gamePath,
    modPath,
    folder: path.join(stagingPath, OVERWRITE_FOLDER),
    made: [],
    madeElsewhere: [],
    changed: 0,
    deleted: 0,
  };
  const inModPath = (filePath: string) => {
    const relative = path.relative(modPath, filePath);
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  };
  for (const entry of overwriteEntriesUnder(gamePath)) {
    if (entry.file === undefined) {
      summary.deleted += 1;
    } else if (isModFile(entry.deployed)) {
      summary.changed += 1;
    } else if (inModPath(entry.deployed)) {
      summary.made.push(entry);
    } else {
      summary.madeElsewhere.push(entry);
    }
  }
  return summary;
}

/**
 * Turn the files programs made in the mod folder into a mod of their own, enabled and
 * deployed, as Mod Organizer's "create mod from overwrite" does. Returns the new mod's id.
 */
export async function createModFromOverwrite(
  api: IExtensionApi,
  gameId: string,
  summary: IOverwriteSummary,
): Promise<string | undefined> {
  if (summary.made.length === 0) {
    return undefined;
  }
  const stagingPath = installPathForGame(api.getState(), gameId);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const modId = `Generated files ${stamp}`;
  const mod: IMod = {
    id: modId,
    state: "installed",
    attributes: {
      name: "Generated files",
      logicalFileName: "Generated files",
      source: "user-generated",
      installTime: new Date().toString(),
      notes: "Files games and tools wrote into the game folder.",
    },
    installationPath: modId,
    type: "",
  };
  await new Promise<void>((resolve, reject) => {
    api.events.emit("create-mod", gameId, mod, (error: Error | null) =>
      error === null ? resolve() : reject(error),
    );
  });
  for (const entry of summary.made) {
    const destination = path.join(
      stagingPath,
      modId,
      path.relative(summary.modPath, entry.deployed),
    );
    await fs.ensureDirAsync(path.dirname(destination));
    await fs.moveAsync(entry.file, destination, { overwrite: true });
  }
  rescanOverwrites();
  const profile = activeProfile(api.getState());
  if (profile?.gameId === gameId) {
    api.store.dispatch(setModEnabled(profile.id, modId, true));
    api.events.emit("deploy-mods", (err: Error | null) => {
      if (err) {
        log("warn", "deploying generated files failed", { error: err.message });
      }
    });
  }
  return modId;
}

/** Discard everything programs wrote, changed and deleted: the game folder as deployed. */
export async function discardOverwrite(api: IExtensionApi, summary: IOverwriteSummary) {
  await fs.removeAsync(summary.folder);
  rescanOverwrites();
}

export async function showOverwriteDialog(api: IExtensionApi): Promise<void> {
  const gameId = activeGameId(api.getState());
  const summary = gameId === undefined ? undefined : overwriteSummary(api, gameId);
  if (gameId === undefined || summary === undefined) {
    return;
  }
  const t = api.translate;
  const text = t(
    "Games and tools wrote into the game folder: {{made}} new files in the mod folder, " +
      "{{elsewhere}} new files elsewhere, {{changed}} changes to mods' files and {{deleted}} " +
      "deletions. They are kept apart from the game in Vortex's staging folder.\n\n" +
      "Changes to mods' files can be imported into their mods or reverted under External " +
      "Changes when you deploy.",
    {
      replace: {
        made: summary.made.length,
        elsewhere: summary.madeElsewhere.length,
        changed: summary.changed,
        deleted: summary.deleted,
      },
    },
  );
  const result = await api.showDialog("info", "Files games and tools wrote", { text }, [
    { label: "Close" },
    { label: "Open folder" },
    { label: "Discard all" },
    ...(summary.made.length > 0 ? [{ label: "Create mod" }] : []),
  ]);
  if (result.action === "Open folder") {
    await fs.ensureDirAsync(summary.folder);
    await opn(summary.folder).catch(() => undefined);
  } else if (result.action === "Create mod") {
    await createModFromOverwrite(api, gameId, summary);
  } else if (result.action === "Discard all") {
    const confirm = await api.showDialog(
      "question",
      "Discard what games and tools wrote?",
      {
        text: t(
          "Every file they made, their changes to mods' files and their deletions are " +
            "removed. This cannot be undone.",
        ),
      },
      [{ label: "Cancel" }, { label: "Discard" }],
    );
    if (confirm.action === "Discard") {
      await discardOverwrite(api, summary);
    }
  }
}
