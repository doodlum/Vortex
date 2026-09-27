import type { IErrorOptions, IExtensionApi } from "../../../types/IExtensionContext";
import type { IState } from "../../../types/IState";
import { extensionErrorOptions } from "../../../util/extensionErrorOptions";
import { describeError, type IErrorDescription } from "../../../util/message";
import { setAutoDeployment } from "../../settings_interface/actions/automation";
import { setDeploymentFailure } from "../actions/session";

/**
 * Why a deployment didn't complete, kept for the menu's Deploy control to show in place of
 * the notification the classic layout raises. Plain data: it lives in the store.
 */
export interface IDeploymentFailure extends IErrorDescription {
  /** Something that stopped the deployment rather than broke it, such as a running tool. */
  warning?: boolean;
  /** Offer to take the user to the setting that has to change first. */
  fix?: "deployment-method";
  /** A passing reason, cleared when it passes rather than at the next deployment. */
  cause?: "tools-running";
}

export interface IDeploymentFailureInput {
  title: string;
  details?: unknown;
  options?: IErrorOptions;
  warning?: boolean;
  fix?: IDeploymentFailure["fix"];
  cause?: IDeploymentFailure["cause"];
}

/**
 * The modern layout shows deployment on the menu's Deploy control, so deploying raises no
 * notifications there: its outcome goes to the control instead.
 */
export const deploysWithoutNotifications = (state: IState): boolean =>
  state.settings.window.useModernLayout ?? true;

/**
 * Reports a deployment that didn't complete: to the menu's Deploy control in the modern
 * layout, which shows it until a deployment succeeds, and through `notify` - the
 * notification it always raised - in the classic one.
 */
export function reportDeploymentFailure(
  api: IExtensionApi,
  gameId: string | undefined,
  input: IDeploymentFailureInput,
  notify: () => void,
): void {
  if (gameId === undefined || !deploysWithoutNotifications(api.getState())) {
    notify();
    return;
  }

  const details = input.details ?? input.title;
  // what api.showErrorNotification adds: the extension the error came from, for its Report
  const options = extensionErrorOptions(
    api.extension,
    () => api.getLoadedExtensions(),
    api.getState(),
    details,
    { ...input.options, warning: input.warning },
  );
  const description = describeError(input.title, details, options);

  api.store.dispatch(
    setDeploymentFailure(gameId, {
      ...description,
      warning: input.warning,
      fix: input.fix,
      cause: input.cause,
    }),
  );
}

/** Clears every game's failure of this cause, once the cause has passed. */
export function clearDeploymentFailures(api: IExtensionApi, cause: IDeploymentFailure["cause"]) {
  const state = api.getState() as IState & {
    session: { mods?: { deploymentFailure?: Record<string, IDeploymentFailure | null> } };
  };
  Object.entries(state.session.mods?.deploymentFailure ?? {}).forEach(([gameId, failure]) => {
    if (failure?.cause === cause) {
      api.store.dispatch(setDeploymentFailure(gameId, null));
    }
  });
}

/** Clears a failure the control shows, once a deployment starts or succeeds. */
export function clearDeploymentFailure(api: IExtensionApi, gameId: string): void {
  const state = api.getState() as IState & {
    session: { mods?: { deploymentFailure?: Record<string, IDeploymentFailure | null> } };
  };
  if (state.session.mods?.deploymentFailure?.[gameId] != null) {
    api.store.dispatch(setDeploymentFailure(gameId, null));
  }
}

/**
 * "Deployment necessary"'s More: why a deployment is needed, with the offer to turn on
 * automatic deployment, and Deploy. `deploy` runs when the user picks Deploy.
 */
export function showDeploymentNecessary(api: IExtensionApi, deploy: () => void) {
  return api
    .showDialog(
      "question",
      "Deployment necessary",
      {
        text:
          "Recent changes to the active mods are currently pending, " +
          "a deployment must be run to apply the latest changes to your game.",
        checkboxes: [
          {
            id: "enable-auto-deployment",
            text: "Enable automatic deployment",
            value: false,
          },
        ],
      },
      [{ label: "Later" }, { label: "Deploy" }],
    )
    .then((res) => {
      if (res.input["enable-auto-deployment"]) {
        api.store.dispatch(setAutoDeployment(true));
      }
      if (res.action === "Deploy") {
        deploy();
      }
    });
}
