import React from "react";
import { useTranslation } from "react-i18next";

import type { DeployStatus } from "@/extensions/mod_management/hooks/useDeployMods.hook";
import { Typography } from "@/ui/components/typography/Typography";
import { joinClasses } from "@/ui/utils/joinClasses";

import { deployCopy, progressLabel } from "./deployCopy";
import { STATE_TEXT, StatusIcon, StatusRowButton } from "./statusRowParts";
import type { IDeployControlProps } from "./types";

/**
 * Status row 2, Two lines: a small state icon, the status on the first line, and under
 * it what the notification said - the running step and percent, why a deployment is
 * necessary, the failure's headline. Collapsed, the icon alone.
 */
export const StatusRowTwoLine = (props: IDeployControlProps) => {
  const { t } = useTranslation();
  const { deploy, play } = props;
  const { status } = deploy;
  const copy = deployCopy(t, deploy);

  const heading: Record<DeployStatus, string> = {
    idle: t("Up to date"),
    deployed: t("Mods deployed"),
    needed: t("Deployment necessary"),
    deploying: t("Deploying"),
    failed: t("Deployment failed"),
  };

  const detail: Record<DeployStatus, string | undefined> = {
    idle: undefined,
    deployed: undefined,
    needed: copy.lines[0],
    deploying: progressLabel(t, deploy),
    failed: deploy.failure !== null ? t(deploy.failure.title) : undefined,
  };

  return (
    <StatusRowButton
      {...props}
      className={joinClasses([
        "flex w-full items-center rounded-lg hover:bg-surface-mid",
        play.isCollapsed ? "h-9 justify-center" : "min-h-11 gap-x-3 px-3 py-1.5",
      ])}
    >
      <StatusIcon status={status} />

      {!play.isCollapsed && (
        <span className="flex min-w-0 grow flex-col text-left">
          <Typography
            as="span"
            brand="none"
            className={joinClasses(["truncate font-semibold", STATE_TEXT[status]], {
              "text-neutral-moderate": status === "idle",
            })}
            typographyType="body-sm"
          >
            {heading[status]}
          </Typography>

          {!!detail[status] && (
            <Typography
              appearance="subdued"
              as="span"
              className="truncate"
              typographyType="body-xs"
            >
              {detail[status]}
            </Typography>
          )}
        </span>
      )}
    </StatusRowButton>
  );
};
