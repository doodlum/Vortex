import React from "react";
import { useTranslation } from "react-i18next";

import type { DeployStatus } from "@/extensions/mod_management/hooks/useDeployMods.hook";
import { Icon } from "@/ui/components/icon/Icon";
import { Typography } from "@/ui/components/typography/Typography";
import { joinClasses } from "@/ui/utils/joinClasses";

import { getIconPath } from "../../iconMap";
import { percentText, rowText } from "./deployCopy";
import { ProgressLine, STATE_TEXT, StatusRowButton } from "./statusRowParts";
import type { IDeployControlProps } from "./types";

/**
 * Status row 3, Progress line: the status on the left and what a click does on the
 * right, with a thin progress line under the row while it deploys. Collapsed, the rocket
 * with the line under it.
 */
export const StatusRowLine = (props: IDeployControlProps) => {
  const { t } = useTranslation();
  const { deploy, play } = props;
  const { status } = deploy;

  const action: Record<DeployStatus, string | undefined> = {
    idle: t("Deploy"),
    deployed: undefined,
    needed: t("Deploy"),
    deploying: percentText(deploy.progressPercent),
    failed: t("Details"),
  };

  return (
    <StatusRowButton
      {...props}
      className={joinClasses([
        "flex w-full flex-col justify-center gap-y-1 rounded-lg hover:bg-surface-mid",
        play.isCollapsed ? "h-9 items-center" : "min-h-9 px-3 py-1",
      ])}
    >
      {play.isCollapsed ? (
        <Icon
          className={joinClasses([STATE_TEXT[status]], {
            "text-neutral-moderate": status === "idle",
          })}
          path={getIconPath("deploy")}
          size="sm"
        />
      ) : (
        <span className="flex w-full items-center gap-x-2">
          <Typography
            as="span"
            brand="none"
            className={joinClasses(["grow truncate text-left font-semibold"], {
              "text-neutral-subdued": status === "idle",
              "text-neutral-moderate": status === "needed" || status === "deploying",
              "text-success-moderate": status === "deployed",
              "text-danger-moderate": status === "failed",
            })}
            typographyType="body-sm"
          >
            {status === "deploying" ? (deploy.progressText ?? t("Deploying")) : rowText(t, deploy)}
          </Typography>

          {!!action[status] && (
            <Typography
              as="span"
              brand="none"
              className={joinClasses(["shrink-0 font-semibold", STATE_TEXT[status]], {
                "text-neutral-moderate": status === "idle",
              })}
              typographyType="body-xs"
            >
              {action[status]}
            </Typography>
          )}
        </span>
      )}

      {status === "deploying" && (
        <span className={joinClasses({ "w-6": play.isCollapsed, "w-full": !play.isCollapsed })}>
          <ProgressLine percent={deploy.progressPercent} />
        </span>
      )}
    </StatusRowButton>
  );
};
