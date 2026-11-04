import path from "path";

import { getErrorCode, unknownToError } from "@vortex/shared";
import PromiseBB from "bluebird";
import memoize from "memoize-one";

import type { IState } from "@/types/api";

import type { IExtensionApi, IExtensionContext } from "../../types/IExtensionContext";
import type { ITestResult } from "../../types/ITestResult";
import * as fs from "../../util/fs";
import { activeGameId, activeProfileId } from "../../util/selectors";
import type { IStarterInfo } from "../../util/StarterInfo";
import { getSafe } from "../../util/storeHelper";
import { truthy } from "../../util/util";
import { gameById, gameName } from "../gamemode_management/selectors";
import type { IDiscoveryResult } from "../gamemode_management/types/IDiscoveryResult";
import { incrementDeploymentCounter } from "../mod_management/reducers/deployment";
import { setPrimaryTool } from "./actions";
import settingsReducer from "./reducers";
import Tools from "./Tools";

const primaryToolChecks = new WeakMap<IExtensionApi, number>();

function supersedePrimaryToolCheck(api: IExtensionApi): number {
  const checkId = (primaryToolChecks.get(api) ?? 0) + 1;
  primaryToolChecks.set(api, checkId);
  return checkId;
}

function testPrimaryTool(api: IExtensionApi): PromiseBB<ITestResult> {
  const checkId = supersedePrimaryToolCheck(api);
  const state = api.store.getState();

  const gameMode = activeGameId(state);
  if (gameMode === undefined) {
    return PromiseBB.resolve(undefined);
  }
  const profileId = activeProfileId(state);
  const primarySelections = state.settings.interface.primaryTool;
  const profileSelections = state.settings.profiles;
  const primaryToolId = getSafe(
    state,
    ["settings", "interface", "primaryTool", gameMode],
    undefined,
  );

  if (truthy(primaryToolId)) {
    // We have a primary tool defined - ensure it's still valid.
    const primaryTool = getSafe(
      state,
      ["settings", "gameMode", "discovered", gameMode, "tools", primaryToolId],
      undefined,
    );

    const selectedPath = primaryTool?.path;
    const selectedWorkingDirectory = primaryTool?.workingDirectory;
    const selectedName = primaryTool?.name;
    const requiredNames: string[] = [...(primaryTool?.requiredFiles ?? [])];
    const stillCurrent = () => {
      const latest = api.store.getState();
      const latestSelections = latest.settings.interface.primaryTool;
      const latestTool = latest.settings.gameMode.discovered[gameMode]?.tools?.[primaryToolId];
      const latestRequired = latestTool?.requiredFiles ?? [];
      return (
        primaryToolChecks.get(api) === checkId &&
        activeGameId(latest) === gameMode &&
        activeProfileId(latest) === profileId &&
        latest.settings.profiles === profileSelections &&
        latestSelections === primarySelections &&
        latestSelections?.[gameMode] === primaryToolId &&
        latestTool?.path === selectedPath &&
        latestTool?.workingDirectory === selectedWorkingDirectory &&
        latestTool?.name === selectedName &&
        latestRequired.length === requiredNames.length &&
        requiredNames.every((file, index) => latestRequired[index] === file)
      );
    };

    // name the missing tool if we can (e.g. "Skyrim Script Extender 64"), the
    // discovered entry may be gone entirely so fall back to the game's tool list
    const toolName: string =
      primaryTool?.name ??
      gameById(state, gameMode)?.supportedTools?.find((tool) => tool.id === primaryToolId)?.name;

    const notifyInvalid = () => {
      const game = gameName(state, gameMode) ?? gameMode;
      const message = toolName !== undefined ? "{{toolName}} is missing" : "Invalid primary tool";
      const text =
        toolName !== undefined
          ? "{{toolName}}, the primary tool for {{game}}, could not be found. It may have" +
            " been moved or uninstalled. Quick launch has reverted to the game's executable."
          : "The primary tool for {{game}} is no longer available." +
            " Quick launch has reverted to the game's executable.";
      api.sendNotification({
        id: "invalid-primary-tool",
        type: "warning",
        message,
        replace: toolName !== undefined ? { toolName } : undefined,
        actions: [
          {
            title: "More",
            action: (dismiss) =>
              api.showDialog(
                "info",
                api.translate(message, { replace: { toolName } }),
                {
                  text: api.translate(text, { replace: { toolName, game } }),
                },
                [{ label: "Close", action: () => dismiss() }],
              ),
          },
        ],
      });
    };

    if (primaryTool === undefined || !truthy(primaryTool.path)) {
      if (stillCurrent()) {
        notifyInvalid();
        if (stillCurrent()) api.store.dispatch(setPrimaryTool(gameMode, undefined));
      }
    } else {
      const workingDir = truthy(primaryTool.workingDirectory)
        ? primaryTool.workingDirectory
        : path.dirname(primaryTool.path);

      // Make sure all the required files are still present.
      const requiredFiles = requiredNames.map((file) => path.join(workingDir, file));
      const physicalExecutable = path.isAbsolute(selectedPath);
      if (physicalExecutable) requiredFiles.push(selectedPath);
      return PromiseBB.each([...new Set(requiredFiles)], async (file: string) => {
        const info = await fs.statAsync(file);
        if (physicalExecutable && file === selectedPath && !info.isFile()) {
          throw Object.assign(new Error("Primary tool path is not a regular file"), {
            code: "ENOTDIR",
          });
        }
      })
        .then(() => {
          if (stillCurrent()) api.dismissNotification("invalid-primary-tool");
          return undefined;
        })
        .catch((err) => {
          if (!stillCurrent()) return undefined;
          const code = getErrorCode(err);
          if (code === "ENOENT" || code === "ENOTDIR") {
            notifyInvalid();
            if (stillCurrent()) api.store.dispatch(setPrimaryTool(gameMode, undefined));
          } else {
            api.showErrorNotification("Failed to check primary tool", unknownToError(err), {
              allowReport: false,
            });
          }
          return undefined;
        });
    }
  }

  return PromiseBB.resolve(undefined);
}

const onDeploymentEvent = async (api: IExtensionApi, profileId: string): Promise<void> => {
  const state = api.store.getState();
  const gameMode = activeGameId(state);
  if (gameMode === undefined || activeProfileId(state) !== profileId) return;
  // Discovery can await while files already reflect this deployment or purge.
  supersedePrimaryToolCheck(api);
  api.store.dispatch(incrementDeploymentCounter(gameMode));
  await api.emitAndAwait("discover-tools", gameMode);
  const latest = api.store.getState();
  if (activeProfileId(latest) !== profileId || activeGameId(latest) !== gameMode) return;
  await testPrimaryTool(api);
};

const toolsValidation = memoize(validateTools);
function init(context: IExtensionContext): boolean {
  context.registerReducer(["settings", "interface"], settingsReducer);

  const onGetValidTools = (starters: IStarterInfo[], gameMode: string) =>
    toolsValidation(context.api, starters, gameMode);

  context.registerDashlet(
    "Tools",
    2,
    2,
    100,
    Tools,
    (state: IState) => !state.settings.window.useModernLayout,
    () => ({
      onGetValidTools,
    }),
    {
      closable: false,
    },
  );

  context.registerTest("primary-tool", "gamemode-activated", () => testPrimaryTool(context.api));

  context.once(() => {
    // Purging and deploying may change the tool state. We need to kick off
    //  a discovery event.
    context.api.onAsync("did-deploy", (profileId: string) =>
      onDeploymentEvent(context.api, profileId),
    );
    context.api.onAsync("did-purge", (profileId: string) =>
      onDeploymentEvent(context.api, profileId),
    );
    context.api.onStateChange(["settings", "interface", "primaryTool"], (_previous, current) => {
      const gameMode = activeGameId(context.api.store.getState());
      if (gameMode === undefined || !truthy(getSafe(current, [gameMode], undefined))) return;
      return testPrimaryTool(context.api).catch((err) => {
        context.api.showErrorNotification("Failed to check primary tool", unknownToError(err), {
          allowReport: false,
        });
      });
    });
  });
  return true;
}

function validateTools(api: IExtensionApi, starters: IStarterInfo[], gameMode: string) {
  const state = api.getState();
  const discovery: IDiscoveryResult = getSafe(
    state,
    ["settings", "gameMode", "discovered", gameMode],
    {},
  );
  if (discovery?.path === undefined) {
    return PromiseBB.resolve([]);
  }

  return PromiseBB.reduce(
    starters,
    (accum, iter) => {
      if (!iter?.exePath) {
        return PromiseBB.resolve(accum);
      }
      const exePath = path.isAbsolute(iter.exePath)
        ? iter.exePath
        : path.join(discovery.path, iter.exePath);
      return fs
        .statAsync(exePath)
        .then(() => accum.push(iter.id))
        .catch(() => PromiseBB.resolve())
        .then(() => PromiseBB.resolve(accum));
    },
    [],
  );
}

export default init;
