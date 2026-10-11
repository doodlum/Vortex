import { unknownToError } from "@vortex/shared";

import type { IExtensionApi } from "@/types/IExtensionContext";
import { UserCanceled } from "@/util/CustomErrors";

import type { IProfile } from "../../profile_management/types/IProfile";
import {
  canShowDeploymentFeedback,
  deploymentProfile,
  describeDeploymentIssue,
  feedbackForRequest,
  finishDeploymentFeedback,
  reportDeploymentIssue,
  startDeploymentFeedback,
  type IDeploymentRequest,
} from "./deploymentFeedback";
import { NoDeployment } from "./exceptions";

/** Owns outcomes even when deployment exits before starting its tracked activity. */
export async function runDeploymentWithFeedback(
  api: IExtensionApi,
  profileId: string | undefined,
  feedbackId: string | undefined,
  run: (profile: IProfile, request: IDeploymentRequest) => Promise<void>,
): Promise<void> {
  const state = api.getState();
  const profile = deploymentProfile(state, profileId);
  // A queued request can outlive its profile, or a newer request for the same game.
  const existing =
    feedbackId === undefined
      ? undefined
      : Object.values(state.session.mods.deploymentFeedback ?? {}).find(
          (feedback) => feedback.requestId === feedbackId && feedback.profileId === profileId,
        );
  if (profile === undefined) {
    if (existing !== undefined) finishDeploymentFeedback(api, existing, { state: "canceled" });
    return;
  }
  const request =
    feedbackId === undefined
      ? startDeploymentFeedback(api, profile)
      : { gameId: profile.gameId, profileId: profile.id, requestId: feedbackId };
  try {
    await run(profile, request);
  } catch (unknownErr) {
    const err = unknownToError(unknownErr);
    if (err instanceof UserCanceled) {
      finishDeploymentFeedback(api, request, { state: "canceled" });
    } else {
      const noMethod = err instanceof NoDeployment;
      const title = noMethod
        ? "You need to select a deployment method in settings"
        : "Failed to deploy mods";
      const options = noMethod ? { allowReport: false } : undefined;
      const issue = {
        title,
        details: err,
        options,
        fix: noMethod ? ("deployment-method" as const) : undefined,
      };
      if (feedbackId === undefined) {
        // Public API/event consumers retain their original rejected-error callback.
        finishDeploymentFeedback(api, request, {
          state: "failed",
          error: describeDeploymentIssue(api, issue),
          fix: issue.fix,
        });
      } else {
        reportDeploymentIssue(api, request, issue, () =>
          api.showErrorNotification(title, err, options),
        );
      }
    }
    // Existing event consumers still receive rejected pre-deployment failures.
    throw err;
  } finally {
    // Early returns and coalesced work are not evidence of successful deployment.
    finishDeploymentFeedback(api, request, { state: "canceled" });
  }
}

/** A null debouncer callback alone does not prove that this request deployed. */
export function completeDeploymentCallback(
  api: IExtensionApi,
  request: IDeploymentRequest,
  err: Error | null,
  announceSuccess = true,
): void {
  const feedback = feedbackForRequest(api.getState(), request);
  if (feedback?.state === "running") {
    finishDeploymentFeedback(api, request, { state: "canceled" });
  } else if (
    err === null &&
    announceSuccess &&
    feedback?.state === "deployed" &&
    !canShowDeploymentFeedback(api.getState(), request)
  ) {
    api.sendNotification({
      id: "mods-deployed",
      type: "info",
      message: "Mods deployed",
      displayMS: 3000,
    });
  }
}
