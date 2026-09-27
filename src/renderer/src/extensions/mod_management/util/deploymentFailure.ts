import shortid from "shortid";

import type { IErrorOptions, IExtensionApi } from "../../../types/IExtensionContext";
import type { IState } from "../../../types/IState";
import { describeError, type IErrorDescription } from "../../../util/message";
import { setDeploymentFailure } from "../actions/session";

/**
 * Why a deployment didn't complete, kept for the menu's Deploy control to show in place of
 * the notification the classic layout raises. Plain data: it lives in the store.
 */
export interface IDeploymentFailure extends IErrorDescription {
  /** Something that stopped the deployment rather than broke it, such as a running tool. */
  warning?: boolean;
  /** Rule cycles to offer to show, for a deployment the mod rules made impossible. */
  cycles?: string[][];
  /** Offer to take the user to the setting that has to change first. */
  fix?: "deployment-method";
}

export interface IDeploymentFailureInput {
  title: string;
  details?: unknown;
  options?: IErrorOptions;
  warning?: boolean;
  cycles?: string[][];
  fix?: IDeploymentFailure["fix"];
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

  const description = describeError(input.title, input.details ?? input.title, {
    ...input.options,
    warning: input.warning,
  });

  api.store.dispatch(
    setDeploymentFailure(gameId, {
      ...description,
      warning: input.warning,
      cycles: input.cycles,
      fix: input.fix,
    }),
  );
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

/** Lists the cycles in the mod rules, each one a link to the editor that can break it. */
export function showCycles(api: IExtensionApi, cycles: string[][], gameId: string) {
  const id = shortid();
  return api.showDialog(
    "error",
    "Cycles",
    {
      text:
        "Dependency rules between your mods contain cycles, " +
        'like "A after B" and "B after A". You need to remove one of the ' +
        "rules causing the cycle, otherwise your mods can't be " +
        "applied in the right order.",
      links: cycles.map((cycle) => ({
        label: cycle.join(", "),
        action: () => {
          api.closeDialog(id);
          api.events.emit("edit-mod-cycle", gameId, cycle);
        },
      })),
    },
    [{ label: "Close" }],
    id,
  );
}
