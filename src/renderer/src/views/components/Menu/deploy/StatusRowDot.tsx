import React from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "@/ui/components/icon/Icon";
import { Typography } from "@/ui/components/typography/Typography";
import { joinClasses } from "@/ui/utils/joinClasses";

import { getIconPath } from "../../iconMap";
import { rowText } from "./deployCopy";
import { StatusDot, StatusRowButton } from "./statusRowParts";
import type { IDeployControlProps } from "./types";

/**
 * Status row 1, Dot: laid out like the menu's page links - a status dot, the status in
 * words, and the rocket on the right. Collapsed, the rocket with the dot as its badge.
 */
export const StatusRowDot = (props: IDeployControlProps) => {
  const { t } = useTranslation();
  const { deploy, play } = props;
  const { status } = deploy;
  const rocket = (
    <Icon
      className={joinClasses(["shrink-0"], {
        "animate-rocket-lift": status === "deploying",
        "text-primary-moderate": status === "needed",
      })}
      path={getIconPath("deploy")}
      size="sm"
    />
  );

  return (
    <StatusRowButton
      {...props}
      className={joinClasses(
        [
          "flex h-9 w-full items-center rounded-lg hover:bg-surface-mid",
          play.isCollapsed ? "justify-center" : "gap-x-3 px-3",
        ],
        {
          "text-neutral-subdued hover:text-neutral-moderate": status === "idle",
          "text-neutral-moderate": status === "needed" || status === "deploying",
          "text-success-moderate": status === "deployed",
          "text-danger-moderate": status === "failed",
        },
      )}
    >
      {play.isCollapsed ? (
        <>
          {rocket}

          {status !== "deploying" && (
            <span className="absolute top-1.5 right-1.5 flex">
              <StatusDot status={status} />
            </span>
          )}
        </>
      ) : (
        <>
          <StatusDot status={status} />

          <Typography
            as="span"
            brand="none"
            className="grow truncate text-left font-semibold"
            typographyType="body-sm"
          >
            {rowText(t, deploy)}
          </Typography>

          {rocket}
        </>
      )}
    </StatusRowButton>
  );
};
