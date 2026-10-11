import shortid from "shortid";

import type { IExtensionApi, IErrorOptions } from "@/types/IExtensionContext";
import type { IState } from "@/types/IState";
import { extensionErrorOptions } from "@/util/extensionErrorOptions";
import { describeError, type IErrorDescription } from "@/util/message";
import { activeProfile } from "@/util/selectors";

import type { IProfile } from "../../profile_management/types/IProfile";
import { beginDeploymentFeedback, updateDeploymentFeedback } from "../actions/session";
import type { IDeploymentFailure } from "../actions/session";

/** Identifies the deployment whose result a control is showing. */
export interface IDeploymentRequest {
  gameId: string;
  profileId: string;
  requestId: string;
}

/** Session-only deployment outcome. The file-failure list remains a separate contract. */
export interface IDeploymentFeedback extends IDeploymentRequest {
  state: "running" | "deployed" | "failed" | "canceled";
  changedAt: number;
  error?: IErrorDescription;
  warning?: boolean;
  fix?: "deployment-method";
  cycles?: string[][];
  files?: IDeploymentFailure[];
}

/** A mounted status control; its owner prevents an old cleanup hiding a replacement. */
export interface IDeploymentControl {
  gameId: string;
  profileId: string;
  owner: string;
}

export interface IDeploymentIssue {
  title: string;
  details?: unknown;
  options?: IErrorOptions;
  warning?: boolean;
  fix?: IDeploymentFeedback["fix"];
  cycles?: string[][];
  files?: IDeploymentFailure[];
}

/** Explicit requests never fall back to a different currently active profile. */
export function deploymentProfile(state: IState, profileId?: string): IProfile | undefined {
  return profileId === undefined ? activeProfile(state) : state.persistent.profiles?.[profileId];
}

export function startDeploymentFeedback(api: IExtensionApi, profile: IProfile): IDeploymentRequest {
  const request = { gameId: profile.gameId, profileId: profile.id, requestId: shortid() };
  api.store.dispatch(
    beginDeploymentFeedback({ ...request, state: "running", changedAt: Date.now() }),
  );
  return request;
}

export function feedbackForRequest(
  state: IState,
  request: IDeploymentRequest,
): IDeploymentFeedback | undefined {
  const feedback = state.session.mods.deploymentFeedback?.[request.gameId];
  return feedback?.requestId === request.requestId && feedback.profileId === request.profileId
    ? feedback
    : undefined;
}

/** Silence notifications only when this exact game's/profile's control is reachable. */
export function canShowDeploymentFeedback(state: IState, request: IDeploymentRequest): boolean {
  const control = state.session.mods.deploymentControl;
  const profile = activeProfile(state);
  return (
    feedbackForRequest(state, request) !== undefined &&
    (state.settings.window.useModernLayout ?? true) &&
    control?.gameId === request.gameId &&
    control.profileId === request.profileId &&
    profile?.id === request.profileId &&
    profile.gameId === request.gameId
  );
}

export function finishDeploymentFeedback(
  api: IExtensionApi,
  request: IDeploymentRequest,
  result: Pick<IDeploymentFeedback, "state"> &
    Partial<Pick<IDeploymentFeedback, "error" | "warning" | "fix" | "cycles" | "files">>,
): boolean {
  const current = feedbackForRequest(api.getState(), request);
  if (current?.state !== "running") return false;
  api.store.dispatch(updateDeploymentFeedback({ ...request, ...result, changedAt: Date.now() }));
  return true;
}

/** Keep the original notification when a newer request or another page owns the UI. */
export function reportDeploymentIssue(
  api: IExtensionApi,
  request: IDeploymentRequest,
  issue: IDeploymentIssue,
  notify: (description: IErrorDescription) => void,
  record = true,
): void {
  const state = api.getState(),
    current = feedbackForRequest(state, request);
  if (current?.state !== "running") {
    if (current?.state !== "failed") notify(describeDeploymentIssue(api, issue, !record, record));
    return;
  }
  const quiet = canShowDeploymentFeedback(state, request);
  // The normal notification records its own telemetry. A quiet status records it here instead.
  const error = describeDeploymentIssue(api, issue, quiet || !record, record);
  finishDeploymentFeedback(api, request, {
    state: "failed",
    error,
    warning: issue.warning ?? issue.options?.warning,
    fix: issue.fix,
    cycles: issue.cycles,
    files: issue.files,
  });
  if (!quiet) notify(error);
}

/** Prepares a request result without taking over an external caller's error reporting. */
export function describeDeploymentIssue(
  api: IExtensionApi,
  issue: IDeploymentIssue,
  record = false,
  recordSpan = true,
): IErrorDescription {
  const details = issue.details ?? issue.title;
  const options = extensionErrorOptions(
    api.extension,
    () => api.getLoadedExtensions(),
    api.getState(),
    details,
    {
      ...issue.options,
      warning: issue.warning ?? issue.options?.warning,
    },
  );
  return describeError(issue.title, details, options, record, recordSpan);
}
