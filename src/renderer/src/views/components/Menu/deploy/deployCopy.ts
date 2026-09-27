import type {
  DeployStatus,
  IDeployMods,
} from "@/extensions/mod_management/hooks/useDeployMods.hook";
import type { TFunction } from "@/util/i18n";

export interface IDeployCopy {
  /** What the control says it does or is doing: a tooltip's first line, an aria-label. */
  title: string;
  /** The tooltip's further lines: what the notification in this state said. */
  lines: string[];
  /** The short text on the control itself. */
  label: string;
  /** A button in the tooltip, as the notification had one: "Deployment necessary"'s More. */
  more?: { label: string; action: () => void };
}

/** "42%", as the activity notification's progress bar put it. */
export const percentText = (percent: number | undefined): string | undefined =>
  percent === undefined ? undefined : `${Math.round(percent)}%`;

/**
 * What every design of the Deploy control says in each state, so they say the same. The
 * strings are the ones the deploy notifications used, so their translations carry over:
 * the modern layout shows them here instead of in the notification centre.
 */
export const deployCopy = (t: TFunction, deploy: IDeployMods): IDeployCopy => {
  const percent = percentText(deploy.progressPercent);

  const copy: Record<DeployStatus, IDeployCopy> = {
    idle: {
      title: t("Deploy Mods"),
      lines: [],
      label: t("Deploy"),
    },
    // the toolbar's success notification
    deployed: {
      title: t("Mods deployed"),
      lines: [],
      label: t("Mods deployed"),
    },
    // "deployment-necessary", and its More dialog's text
    needed: {
      title: t("Deployment necessary"),
      lines: [
        t(
          "Recent changes to the active mods are currently pending, " +
            "a deployment must be run to apply the latest changes to your game.",
        ),
      ],
      label: t("Deploy"),
      more: deploy.autoDeploy ? undefined : { label: t("More"), action: deploy.showNecessary },
    },
    // the "Deploying" activity notification: its message, its progress text and percent
    deploying: {
      title: t("Deploying"),
      lines: deploy.isWaiting
        ? [t("Waiting for other operations to complete")]
        : [
            t("Deploying mods"),
            ...(deploy.progressText !== undefined ? [deploy.progressText] : []),
            ...(percent !== undefined ? [percent] : []),
          ],
      label: t("Deploying..."),
    },
    // whichever notification the failure replaced, whose details the dialog holds
    failed: {
      title: t("Deployment failed"),
      lines: deploy.failure !== null ? [t(deploy.failure.title), t("Click for details.")] : [],
      label: t("Deploy failed"),
    },
  };

  return copy[deploy.status];
};

/** What a running deployment's text on the control says: its step and how far along. */
export const progressLabel = (t: TFunction, deploy: IDeployMods): string => {
  if (deploy.isWaiting) {
    return t("Waiting for other operations to complete");
  }
  const percent = percentText(deploy.progressPercent);
  const step = deploy.progressText ?? t("Deploying mods");
  return percent === undefined ? step : `${step} ${percent}`;
};

/**
 * The status a row says in words: the notifications' own strings where one said it, so
 * "Deployment necessary", the running step and percent, "Mods deployed", the failure's
 * headline. "Up to date" is the row's own, as nothing was said when nothing was pending.
 */
export const rowText = (t: TFunction, deploy: IDeployMods): string => {
  switch (deploy.status) {
    case "idle":
      return t("Up to date");
    case "deployed":
      return t("Mods deployed");
    case "needed":
      return t("Deployment necessary");
    case "deploying":
      return progressLabel(t, deploy);
    case "failed":
      return deploy.failure !== null ? t(deploy.failure.title) : t("Deployment failed");
  }
};

/** What clicking the control does in each state: nothing while it deploys. */
export const deployAction = (deploy: IDeployMods): (() => void) | undefined => {
  switch (deploy.status) {
    case "deploying":
      return undefined;
    case "failed":
      return deploy.showFailure;
    default:
      return () => deploy.deploy();
  }
};
