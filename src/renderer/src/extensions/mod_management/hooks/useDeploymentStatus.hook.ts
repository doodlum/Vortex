import { useCallback, useEffect, useState } from "react";
import { useDispatch, useSelector } from "react-redux";

import { setSettingsPage } from "@/actions";
import type { IDialogAction } from "@/actions/notifications";
import { useMainContext } from "@/contexts";
import type { IState } from "@/types/IState";
import { errorDialogActions } from "@/util/message";
import { activeProfile } from "@/util/selectors";

import { showDeploymentFailureFiles } from "../util/deploymentFailures";
import type { IDeploymentFeedback } from "../util/deploymentFeedback";
import { showCycles } from "../util/showCycles";

export const DEPLOYED_DISPLAY_MS = 3000;

const selectFeedback = (state: IState): IDeploymentFeedback | undefined => {
  const profile = activeProfile(state);
  const feedback =
    profile === undefined ? undefined : state.session.mods.deploymentFeedback?.[profile.gameId];
  return feedback?.profileId === profile?.id ? feedback : undefined;
};

/** The active profile's latest result, with a finite, request-owned success display. */
export function useDeploymentStatus(retry: () => void): {
  feedback: IDeploymentFeedback | undefined;
  showFailure: () => void;
} {
  const { api } = useMainContext();
  const dispatch = useDispatch();
  const feedback = useSelector(selectFeedback);
  const [expired, setExpired] = useState<IDeploymentFeedback>();

  useEffect(() => {
    if (feedback?.state !== "deployed") return;
    const remaining = feedback.changedAt + DEPLOYED_DISPLAY_MS - Date.now();
    const timer = setTimeout(() => setExpired(feedback), Math.max(0, remaining));
    return () => clearTimeout(timer);
  }, [feedback]);

  const showFailure = useCallback(() => {
    if (feedback?.state !== "failed" || feedback.error === undefined) return;
    const stillCurrent = () => {
      const state = api.getState();
      const profile = activeProfile(state);
      return (
        profile?.id === feedback.profileId &&
        profile.gameId === feedback.gameId &&
        state.session.mods.deploymentFeedback?.[feedback.gameId]?.requestId === feedback.requestId
      );
    };
    const extra: IDialogAction[] = [];
    if (feedback.fix === "deployment-method") {
      extra.push({
        label: "Fix",
        action: () => {
          if (!stillCurrent()) return;
          api.events.emit("show-main-page", "application_settings");
          dispatch(setSettingsPage("Mods"));
        },
      });
    }
    if (feedback.cycles !== undefined) {
      extra.push({
        label: "Show",
        action: () => {
          if (stillCurrent()) void showCycles(api, feedback.cycles!, feedback.gameId);
        },
      });
    }
    if (feedback.files !== undefined && feedback.files.length > 0) {
      extra.push({
        label: "Files",
        action: () => {
          void showDeploymentFailureFiles(api, feedback.files!);
        },
      });
    }
    const reports = errorDialogActions(dispatch, feedback.error).filter(
      (action) => action.label !== "Close",
    );
    void api.showDialog(
      feedback.warning ? "info" : "error",
      feedback.error.title,
      feedback.error.content,
      [
        ...reports,
        ...extra,
        { label: "Close", default: true },
        {
          label: "Retry",
          action: () => {
            if (stillCurrent()) retry();
          },
        },
      ],
    );
  }, [api, dispatch, feedback, retry]);

  return {
    feedback:
      feedback === expired ||
      (feedback?.state === "deployed" && feedback.changedAt + DEPLOYED_DISPLAY_MS <= Date.now())
        ? undefined
        : feedback,
    showFailure,
  };
}
