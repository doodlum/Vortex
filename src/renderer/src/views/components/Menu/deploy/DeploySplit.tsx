import { mdiAlertCircleOutline } from "@mdi/js";
import React from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "@/ui/components/icon/Icon";
import { joinClasses } from "@/ui/utils/joinClasses";

import { getIconPath } from "../../iconMap";
import { PlayButton } from "../PlayButton";
import { deployAction, deployCopy } from "./deployCopy";
import { DeployTooltip } from "./DeployTooltip";
import type { IDeployControlProps } from "./types";

/**
 * 2, Split: Deploy and Play as one control, a rocket segment joined to Play - beside it
 * when the menu is expanded, above it when collapsed. The segment takes the state's colour.
 */
export const DeploySplit = ({ deploy, play }: IDeployControlProps) => {
  const { t } = useTranslation();
  const copy = deployCopy(t, deploy);
  const { status } = deploy;
  const collapsed = play.isCollapsed;

  return (
    <div
      className={joinClasses(["flex w-full rounded-sm"], {
        "flex-col": collapsed,
        "flex-row": !collapsed,
      })}
      data-deploy-split
    >
      <DeployTooltip copy={copy}>
        <button
          aria-busy={status === "deploying" || undefined}
          aria-label={copy.title}
          className={joinClasses(
            [
              "flex shrink-0 items-center justify-center transition-colors",
              "focus-visible:z-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-subdued",
              collapsed ? "h-8 w-10 rounded-t-sm border-b" : "h-12 w-12 rounded-l-sm border-r",
            ],
            {
              "border-translucent-dark-200 bg-neutral-strong text-neutral-inverted hover:bg-neutral-subdued":
                status === "idle",
              "border-translucent-dark-200 bg-primary-moderate text-neutral-inverted hover:bg-primary-strong":
                status === "needed",
              "cursor-progress border-translucent-dark-200 bg-neutral-subdued text-neutral-inverted":
                status === "deploying",
              "border-translucent-dark-200 bg-danger-moderate text-neutral-inverted hover:bg-danger-strong":
                status === "failed",
            },
          )}
          data-deploy-state={status}
          data-testid="deploy-mods"
          type="button"
          onClick={deployAction(deploy)}
        >
          <Icon
            className={joinClasses({ "animate-rocket-lift": status === "deploying" })}
            path={status === "failed" ? mdiAlertCircleOutline : getIconPath("deploy")}
            size={collapsed ? undefined : "lg"}
          />
        </button>
      </DeployTooltip>

      <PlayButton {...play} className={collapsed ? "rounded-t-none" : "rounded-l-none"} />
    </div>
  );
};
