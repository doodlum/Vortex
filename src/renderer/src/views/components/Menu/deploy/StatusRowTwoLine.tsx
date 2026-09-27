import React from "react";
import { useTranslation } from "react-i18next";

import { Typography } from "@/ui/components/typography/Typography";
import { joinClasses } from "@/ui/utils/joinClasses";

import { deployCopy } from "./deployCopy";
import { STATE_TEXT, StatusIcon, StatusRowButton } from "./statusRowParts";
import type { IDeployControlProps } from "./types";

/**
 * Status row 2, Two lines: a small state icon, the short status on the first line, and
 * under it one short sentence - the running step, why, or the failure. Collapsed, the icon.
 */
export const StatusRowTwoLine = (props: IDeployControlProps) => {
  const { t } = useTranslation();
  const { deploy, play } = props;
  const { status } = deploy;
  const copy = deployCopy(t, deploy);

  // the short status, and under it the one short sentence the tooltip has
  const heading = copy.title;
  const detail = copy.lines[0];

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
            {heading}
          </Typography>

          {!!detail && (
            <Typography
              appearance="subdued"
              as="span"
              className="truncate"
              typographyType="body-xs"
            >
              {detail}
            </Typography>
          )}
        </span>
      )}
    </StatusRowButton>
  );
};
