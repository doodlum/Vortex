import React from "react";
import { useTranslation } from "react-i18next";

import type { DeployStatus } from "@/extensions/mod_management/hooks/useDeployMods.hook";
import { Typography } from "@/ui/components/typography/Typography";
import { joinClasses } from "@/ui/utils/joinClasses";

import { percentText, rowText } from "./deployCopy";
import { StatusIcon, StatusRowButton } from "./statusRowParts";
import type { IDeployControlProps } from "./types";

const TINT: Record<DeployStatus, string> = {
  idle: "text-neutral-subdued hover:bg-surface-mid hover:text-neutral-moderate",
  deployed: "bg-success-950 text-success-strong",
  needed: "bg-primary-950 text-primary-strong hover:bg-primary-900",
  deploying: "bg-info-950 text-info-strong",
  failed: "bg-danger-950 text-danger-strong hover:bg-danger-900",
};

/**
 * Status row 5, Tint: the whole row takes the state's colour - quiet when everything is
 * deployed - with the state's icon, the status in words, and the percent on the right
 * while it deploys. Collapsed, a tinted square with the icon.
 */
export const StatusRowTint = (props: IDeployControlProps) => {
  const { t } = useTranslation();
  const { deploy, play } = props;
  const { status } = deploy;
  const percent = status === "deploying" ? percentText(deploy.progressPercent) : undefined;

  return (
    <StatusRowButton
      {...props}
      className={joinClasses(
        [
          "flex h-9 w-full items-center rounded-lg",
          play.isCollapsed ? "justify-center" : "gap-x-3 px-3",
        ],
        { [TINT[status]]: true },
      )}
    >
      <StatusIcon status={status} />

      {!play.isCollapsed && (
        <>
          <Typography
            as="span"
            brand="none"
            className="grow truncate text-left font-semibold"
            typographyType="body-sm"
          >
            {status === "deploying" ? (deploy.progressText ?? t("Deploying")) : rowText(t, deploy)}
          </Typography>

          {!!percent && (
            <Typography
              as="span"
              brand="none"
              className="shrink-0 font-semibold tabular-nums"
              typographyType="body-xs"
            >
              {percent}
            </Typography>
          )}
        </>
      )}
    </StatusRowButton>
  );
};
