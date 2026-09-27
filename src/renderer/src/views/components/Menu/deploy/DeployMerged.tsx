import React from "react";
import { useTranslation } from "react-i18next";

import { getIconPath } from "../../iconMap";
import { type IPlayOverride, PlayButton } from "../PlayButton";
import { deployCopy } from "./deployCopy";
import type { IDeployControlProps } from "./types";

/**
 * 5, Merged: no Deploy control of its own. Play takes deployment on: "Deploy & Play" while
 * changes wait, deploying and then launching; the rocket while a deployment runs; a red
 * badge after one failed. Collapsed, a badge on Play says which.
 */
export const DeployMerged = ({ deploy, play }: IDeployControlProps) => {
  const { t } = useTranslation();
  const copy = deployCopy(t, deploy);
  const { status } = deploy;

  const overrides: Record<typeof status, IPlayOverride | undefined> = {
    idle: undefined,
    // Only deploys when there's nothing to launch after, or it couldn't launch now.
    needed: {
      label: play.disabled ? copy.label : t("Deploy & Play"),
      description: copy.description,
      brand: "primary",
      iconPath: getIconPath("deploy"),
      badge: "primary",
      onClick: () => deploy.deploy(play.disabled ? undefined : play.onClick),
    },
    deploying: {
      label: copy.label,
      iconPath: getIconPath("deploy"),
      iconClassName: "animate-rocket-lift",
      busy: true,
    },
    failed: {
      label: copy.label,
      description: copy.description,
      badge: "danger",
      onClick: deploy.showFailure,
    },
  };

  return (
    <div className="w-full" data-deploy-state={status} data-testid="deploy-mods">
      <PlayButton
        {...play}
        // Deploying doesn't need the game to be launchable, only Play itself does.
        disabled={status === "idle" ? play.disabled : false}
        override={overrides[status]}
      />
    </div>
  );
};
