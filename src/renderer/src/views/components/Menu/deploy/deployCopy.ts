import type {
  DeployStatus,
  IDeployMods,
} from "@/extensions/mod_management/hooks/useDeployMods.hook";
import type { TFunction } from "@/util/i18n";

export interface IDeployCopy {
  /** The short status: a tooltip's first line, the collapsed row's name, the row's text. */
  title: string;
  /** At most one short sentence under it. */
  lines: string[];
  /** The short text on the control itself; the same as the title. */
  label: string;
  /**
   * The button to the full story: "Deployment necessary"'s More, whose dialog keeps the
   * notification's original text and automatic deployment offer.
   */
  more?: { label: string; action: () => void };
}

/** "42%", as the activity notification's progress bar put it. */
export const percentText = (percent: number | undefined): string | undefined =>
  percent === undefined ? undefined : `${Math.round(percent)}%`;

/** "Applying... 42%", or "Waiting..." for a deployment that hasn't started yet. */
export const progressLabel = (t: TFunction, deploy: IDeployMods): string => {
  if (deploy.isWaiting) {
    return t("Waiting...");
  }
  const percent = percentText(deploy.progressPercent);
  return percent === undefined ? t("Applying...") : `${t("Applying...")} ${percent}`;
};

/**
 * What every row style says in each state, and Play with it: short, action-first labels.
 * The notifications' full wording is kept where the user asks for it - the "Deployment
 * necessary" dialog behind More, and a failure's details dialog behind a click.
 */
export const deployCopy = (t: TFunction, deploy: IDeployMods): IDeployCopy => {
  const short = (title: string, line?: string): IDeployCopy => ({
    title,
    label: title,
    lines: line !== undefined ? [line] : [],
  });

  switch (deploy.status) {
    case "idle":
      return short(t("Up to date"));
    case "deployed":
      return short(t("Changes applied"));
    case "needed":
      return {
        ...short(t("Apply changes"), t("Mods changed since the last deploy.")),
        more: deploy.autoDeploy ? undefined : { label: t("More"), action: deploy.showNecessary },
      };
    case "deploying":
      // the running step, as the handler says it ("Deploying: <mod>")
      return short(
        progressLabel(t, deploy),
        deploy.isWaiting
          ? t("Waiting for other operations to complete")
          : (deploy.progressText ?? undefined),
      );
    case "failed":
      return short(
        t("Couldn't apply"),
        deploy.failure !== null ? t(deploy.failure.title) : undefined,
      );
  }
};

/** The row's text: the short status. */
export const rowText = (t: TFunction, deploy: IDeployMods): string => deployCopy(t, deploy).title;

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
