import { mdiAlertCircleOutline } from "@mdi/js";
import React from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/ui/components/button/Button";
import { Icon } from "@/ui/components/icon/Icon";
import { Typography } from "@/ui/components/typography/Typography";
import { joinClasses } from "@/ui/utils/joinClasses";

import { getIconPath } from "../../iconMap";
import { PlayButton } from "../PlayButton";
import { deployAction, deployCopy } from "./deployCopy";
import { DeployTooltip } from "./DeployTooltip";
import type { IDeployControlProps } from "./types";

/**
 * 4, Rocket: a Deploy button the width of Play above it, icon-only when the menu is
 * collapsed, whose rocket takes off while a deployment runs.
 */
export const DeployRocket = ({ deploy, play }: IDeployControlProps) => {
  const { t } = useTranslation();
  const copy = deployCopy(t, deploy);
  const { status } = deploy;
  const collapsed = play.isCollapsed;

  return (
    <div className="flex w-full flex-col gap-y-2">
      <DeployTooltip copy={copy}>
        <Button
          aria-busy={status === "deploying" || undefined}
          aria-label={collapsed ? copy.title : undefined}
          appearance={
            status === "needed" ? undefined : status === "deploying" ? "moderate" : "subdued"
          }
          brand={status === "failed" ? "danger" : status === "idle" ? "neutral" : undefined}
          className={joinClasses(["h-10 w-full"], { "cursor-progress": status === "deploying" })}
          customContent={
            <>
              <span className="nxm-button-icon relative size-6 overflow-hidden">
                <Icon
                  className={joinClasses(["absolute inset-0"], {
                    "animate-rocket-launch": status === "deploying",
                  })}
                  path={status === "failed" ? mdiAlertCircleOutline : getIconPath("deploy")}
                  size="lg"
                />
              </span>

              {!collapsed && (
                <Typography
                  as="span"
                  brand="none"
                  className="font-semibold"
                  typographyType="body-lg"
                >
                  {copy.label}
                </Typography>
              )}
            </>
          }
          data-deploy-state={status}
          data-testid="deploy-mods"
          onClick={deployAction(deploy)}
        />
      </DeployTooltip>

      <PlayButton {...play} />
    </div>
  );
};
