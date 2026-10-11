import { useCallback, useMemo } from "react";
import { useDispatch, useSelector } from "react-redux";

import { setSettingsPage } from "@/actions";
import { useMainContext } from "@/contexts";
import type { IState } from "@/types/IState";
import onceCB from "@/util/onceCB";
import * as selectors from "@/util/selectors";

import { completeDeploymentCallback } from "../util/deploymentExecution";
import {
  deploymentProfile,
  reportDeploymentIssue,
  startDeploymentFeedback,
} from "../util/deploymentFeedback";
import { getAllActivators } from "../util/deploymentMethods";

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

/** Includes the request's gate/installer wait, before its deployment activity starts. */
const deploymentInProgress = (state: IState): boolean => {
  const profile = selectors.activeProfile(state);
  const feedback =
    profile === undefined ? undefined : state.session.mods.deploymentFeedback?.[profile.gameId];
  return (
    (feedback?.profileId === profile?.id && feedback?.state === "running") ||
    (state.session.base.activity?.mods ?? []).some((id) =>
      ["deployment", "deployment_pending"].includes(id),
    )
  );
};

/**
 * Deploys the active profile's mods, as the Deploy toolbar action and the menu's Apply
 * button both do. Warns instead when the game has no deployment method set.
 */
export const useDeployMods = (): {
  needToDeploy: boolean;
  /** Changes deploy on their own, so there's nothing for the user to apply. */
  autoDeploy: boolean;
  isDeploying: boolean;
  /** 0-100 while deploying; undefined otherwise. */
  deployProgress: number | undefined;
  /** What the deploy is doing, e.g. the mod it's on; undefined when idle. */
  deployStep: string | undefined;
  deploy: () => void;
} => {
  const { api } = useMainContext();
  const needToDeploy = useSelector(selectors.needToDeploy);
  const autoDeploy = useSelector((state: IState) => state.settings.automation.deploy);

  const isDeploying = useSelector(deploymentInProgress);
  const percent = useSelector(
    (state: IState) => state.session.base.progress?.mods?.deployment?.percent,
  );
  const step = useSelector((state: IState) => state.session.base.progress?.mods?.deployment?.text);
  const profileId = useSelector(selectors.activeProfileId);
  const noMethod = useNoMethodWarning();

  const deploy = useCallback(() => {
    const state = api.getState();
    if (deploymentInProgress(state)) return;
    const profile = deploymentProfile(state, profileId);
    if (profile === undefined) return;
    const request = startDeploymentFeedback(api, profile);
    // Dialog actions can outlive the render that created them. Read the current
    // method so Retry uses a repaired selection, or refuses one removed since.
    const activatorId = state.settings.mods.activator?.[profile.gameId];
    const activator = getAllActivators().find((method) => method.id === activatorId);
    if (activator === undefined) {
      reportDeploymentIssue(
        api,
        request,
        {
          title: "You have to select a deployment method first",
          warning: true,
          options: { allowReport: false },
          fix: "deployment-method",
        },
        noMethod,
      );
      return;
    }
    api.events.emit(
      "deploy-mods",
      onceCB((err: Error | null) => completeDeploymentCallback(api, request, err)),
      profileId,
      undefined,
      { manual: true, feedbackId: request.requestId },
    );
  }, [api, profileId, noMethod]);

  return {
    needToDeploy,
    autoDeploy,
    isDeploying,
    deployProgress: isDeploying ? (percent ?? 0) : undefined,
    deployStep: isDeploying ? step || undefined : undefined,
    deploy,
  };
};
