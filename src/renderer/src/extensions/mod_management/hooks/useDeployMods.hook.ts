import { useCallback, useMemo } from "react";
import { useDispatch, useSelector } from "react-redux";

import { setSettingsPage } from "@/actions";
import type { IDialogAction } from "@/actions/notifications";
import { useMainContext } from "@/contexts";
import type { IState } from "@/types/IState";
import { UserCanceled } from "@/util/CustomErrors";
import { errorDialogActions } from "@/util/message";
import onceCB from "@/util/onceCB";
import * as selectors from "@/util/selectors";

import {
  type IDeploymentFailure,
  reportDeploymentFailure,
  showCycles,
} from "../util/deploymentFailure";
import { getAllActivators } from "../util/deploymentMethods";
import { NoDeployment } from "../util/exceptions";

/** Tells the user no deployment method is set, and offers to take them there. */
export const useNoMethodWarning = () => {
  const { api } = useMainContext();
  const dispatch = useDispatch();

  return useCallback(() => {
    api.sendNotification({
      id: "select-deployment-method-first",
      type: "warning",
      message: "You have to select a deployment method first",
      actions: [
        {
          title: "Fix",
          action: (dismiss: () => void) => {
            api.events.emit("show-main-page", "application_settings");
            dispatch(setSettingsPage("Mods"));
            dismiss();
          },
        },
      ],
    });
  }, [api, dispatch]);
};

/** The deployment method the active game is set to use, if it resolves to one. */
export const useActivator = () => {
  const gameId = useSelector(selectors.activeGameId);
  const activatorId = useSelector((state: IState) => state.settings.mods.activator?.[gameId]);

  return useMemo(
    () =>
      activatorId === undefined
        ? undefined
        : getAllActivators().find((activator) => activator.id === activatorId),
    [activatorId],
  );
};

/** Set by the deploy handler for as long as a deployment runs, purges excluded. */
const isDeployingSelector = (state: IState): boolean =>
  state.session.base.activity?.mods?.includes("deployment") ?? false;

const needToDeploySelector = (state: IState): boolean => selectors.needToDeploy(state) === true;

type IStateWithFailures = IState & {
  session: { mods?: { deploymentFailure?: Record<string, IDeploymentFailure | null> } };
};

/** Why the active game's last deployment didn't complete, until one does. */
const failureSelector = (state: IState): IDeploymentFailure | null =>
  (state as IStateWithFailures).session.mods?.deploymentFailure?.[selectors.activeGameId(state)] ??
  null;

/** What the deploy handler says it is doing, in place of the notification it would update. */
const progressTextSelector = (state: IState): string | undefined =>
  state.session.base.progress?.["deployment"]?.[selectors.activeGameId(state)]?.text || undefined;

export type DeployStatus = "idle" | "needed" | "deploying" | "failed";

export interface IDeployMods {
  /**
   * Deploys the active profile, or reports that there is no deployment method to do it
   * with. `onDeployed` runs once the deployment completed without a failure.
   */
  deploy: (onDeployed?: () => void) => void;
  /** Why the last deployment didn't complete, while that is still the latest news. */
  failure: IDeploymentFailure | null;
  /** Whether a deployment of the active game is running now. */
  isDeploying: boolean;
  /** Whether one was asked for and waits for another operation to finish first. */
  isWaiting: boolean;
  /** Whether the active game has changes that haven't been deployed yet. */
  needToDeploy: boolean;
  /** What a running deployment says it is doing, when it has said anything. */
  progressText: string | undefined;
  /** Opens the details of {@link failure}, with a way to retry. */
  showFailure: () => void;
  /** The one state a control shows, most pressing first. */
  status: DeployStatus;
}

export const deployStatus = (
  isDeploying: boolean,
  failure: IDeploymentFailure | null,
  needToDeploy: boolean,
): DeployStatus =>
  isDeploying ? "deploying" : failure !== null ? "failed" : needToDeploy ? "needed" : "idle";

/**
 * Deploy Mods, as the user asks for it from the menu: the `deploy-mods` event for the
 * active game's profile, marked manual. It raises no notifications: the control shows
 * progress, and a deployment that doesn't complete leaves a failure for it to show.
 */
export const useDeployMods = (): IDeployMods => {
  const { api } = useMainContext();
  const dispatch = useDispatch();
  const activator = useActivator();
  const needToDeploy = useSelector(needToDeploySelector);
  const isDeploying = useSelector(isDeployingSelector);
  const failure = useSelector(failureSelector);
  const progressText = useSelector(progressTextSelector);
  // Progress without the activity is a deployment that hasn't started yet.
  const isWaiting = !isDeploying && progressText !== undefined;
  const gameId = useSelector(selectors.activeGameId);
  const profileId = useSelector((state: IState) =>
    selectors.lastActiveProfileForGame(state, gameId),
  );
  const noMethodWarning = useNoMethodWarning();

  const noMethod = useCallback(() => {
    reportDeploymentFailure(
      api,
      gameId,
      {
        title: "You have to select a deployment method first",
        warning: true,
        fix: "deployment-method",
      },
      noMethodWarning,
    );
  }, [api, gameId, noMethodWarning]);

  const deployWithMethod = useCallback(
    (onDeployed?: () => void) => {
      api.events.emit(
        "deploy-mods",
        onceCB((err: Error | null) => {
          if (err === null) {
            // the handler reports its own failures rather than passing them on
            if (onDeployed !== undefined && failureSelector(api.getState()) === null) {
              onDeployed();
            }
            return;
          }

          if (err instanceof UserCanceled) {
            return;
          }

          if (err instanceof NoDeployment) {
            reportDeploymentFailure(
              api,
              gameId,
              {
                title: "You need to select a deployment method in settings",
                options: { allowReport: false },
                fix: "deployment-method",
              },
              () =>
                api.showErrorNotification(
                  "You need to select a deployment method in settings",
                  undefined,
                  { allowReport: false },
                ),
            );
            return;
          }

          reportDeploymentFailure(
            api,
            gameId,
            { title: "Failed to activate mods", details: err },
            () => api.showErrorNotification("Failed to activate mods", err),
          );
        }),
        profileId,
        undefined,
        { manual: true },
      );
    },
    [api, gameId, profileId],
  );

  const deploy = activator !== undefined ? deployWithMethod : noMethod;

  const showFailure = useCallback(() => {
    if (failure === null) {
      return;
    }

    const extra: IDialogAction[] = [];
    if (failure.cycles !== undefined) {
      const cycles = failure.cycles;
      extra.push({ label: "Show cycles", action: () => void showCycles(api, cycles, gameId) });
    }
    if (failure.fix === "deployment-method") {
      extra.push({
        label: "Fix",
        action: () => {
          api.events.emit("show-main-page", "application_settings");
          dispatch(setSettingsPage("Mods"));
        },
      });
    }

    const report = errorDialogActions(dispatch, failure).filter(
      (action) => action.label !== "Close",
    );

    void api.showDialog(failure.warning ? "info" : "error", failure.title, failure.content, [
      ...report,
      ...extra,
      { label: "Close" },
      { label: "Retry", default: true, action: () => deploy() },
    ]);
  }, [api, deploy, dispatch, failure, gameId]);

  return useMemo(
    () => ({
      deploy,
      failure,
      isDeploying,
      isWaiting,
      needToDeploy,
      progressText,
      showFailure,
      status: deployStatus(isDeploying || isWaiting, failure, needToDeploy),
    }),
    [deploy, failure, isDeploying, isWaiting, needToDeploy, progressText, showFailure],
  );
};
