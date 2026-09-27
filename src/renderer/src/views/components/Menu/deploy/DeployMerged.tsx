import React from "react";
import { useTranslation } from "react-i18next";

import { getIconPath } from "../../iconMap";
import { type IPlayOverride, PlayButton } from "../PlayButton";
import { deployCopy, percentText } from "./deployCopy";
import { DeployTooltipContent } from "./DeployTooltip";
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
  const details = <DeployTooltipContent copy={copy} padded={false} />;
  const percent = percentText(deploy.progressPercent);

  const overrides: Record<typeof status, IPlayOverride | undefined> = {
    idle: undefined,
    // "Mods deployed" for a moment; Play still plays.
    deployed: {
      label: copy.label,
      details,
      brand: "success",
      onClick: play.onClick,
    },
    // Only deploys when there's nothing to launch after, or it couldn't launch now.
    needed: {
      label: play.disabled ? copy.label : t("Deploy & Play"),
      details,
      interactive: copy.more !== undefined,
      brand: "primary",
      iconPath: getIconPath("deploy"),
      badge: "primary",
      onClick: () => deploy.deploy(play.disabled ? undefined : play.onClick),
    },
    deploying: {
      label: percent === undefined ? copy.label : `${copy.label} ${percent}`,
      details,
      iconPath: getIconPath("deploy"),
      iconClassName: "animate-rocket-lift",
      busy: true,
    },
    failed: {
      label: copy.label,
      details,
      badge: "danger",
      onClick: deploy.showFailure,
    },
  };

  return (
    <div className="w-full" data-deploy-state={status} data-testid="deploy-mods">
      <PlayButton
        {...play}
        // Deploying doesn't need the game to be launchable, only Play itself does.
        disabled={status === "idle" || status === "deployed" ? play.disabled : false}
        override={overrides[status]}
      />
    </div>
  );
};
