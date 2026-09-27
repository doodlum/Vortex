import type {
  DeployStatus,
  IDeployMods,
} from "@/extensions/mod_management/hooks/useDeployMods.hook";
import type { TFunction } from "@/util/i18n";

export interface IDeployCopy {
  /** What the control says it does or is doing: a tooltip's first line, an aria-label. */
  title: string;
  /** A tooltip's second line, where there's more to say. */
  description?: string;
  /** The short text on the control itself. */
  label: string;
}

/** What every design of the Deploy control says in each state, so they say the same. */
export const deployCopy = (t: TFunction, deploy: IDeployMods): IDeployCopy => {
  const copy: Record<DeployStatus, IDeployCopy> = {
    idle: {
      title: t("Deploy mods"),
      description: t("Your mods are deployed."),
      label: t("Deploy"),
    },
    needed: {
      title: t("Deploy mods"),
      description: t("You have changes that haven't been deployed to the game yet."),
      label: t("Deploy"),
    },
    deploying: {
      title: t("Deploying mods..."),
      description: deploy.progressText,
      label: t("Deploying..."),
    },
    failed: {
      title: t("Deployment failed"),
      description:
        deploy.failure !== null
          ? `${t(deploy.failure.title)}. ${t("Click for details.")}`
          : undefined,
      label: t("Deploy failed"),
    },
  };

  return copy[deploy.status];
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
