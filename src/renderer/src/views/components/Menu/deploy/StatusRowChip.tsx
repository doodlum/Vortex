import React from "react";
import { useTranslation } from "react-i18next";

import type { DeployStatus } from "@/extensions/mod_management/hooks/useDeployMods.hook";
import { Typography } from "@/ui/components/typography/Typography";
import { joinClasses } from "@/ui/utils/joinClasses";

import { rowText } from "./deployCopy";
import { StatusDot, StatusIcon, StatusRowButton } from "./statusRowParts";
import type { IDeployControlProps } from "./types";

const CHIP: Record<DeployStatus, string> = {
  idle: "border-stroke-weak text-neutral-subdued hover:border-stroke-subdued",
  deployed: "border-success-weak text-success-strong",
  needed: "border-primary-weak text-primary-strong hover:border-primary-subdued",
  deploying: "border-info-weak text-info-strong",
  failed: "border-danger-weak text-danger-strong hover:border-danger-subdued",
};

/**
 * Status row 4, Chip: an outlined pill centred over Play, its border in the state's
 * colour, holding the dot and the status in words. Collapsed, a round chip with the
 * state's icon.
 */
export const StatusRowChip = (props: IDeployControlProps) => {
  const { t } = useTranslation();
  const { deploy, play } = props;
  const { status } = deploy;

  return (
    <div className="flex w-full justify-center">
      <StatusRowButton
        {...props}
        className={joinClasses(
          [
            "flex items-center justify-center rounded-full border",
            play.isCollapsed ? "size-9" : "h-7 max-w-full gap-x-2 px-3",
          ],
          { [CHIP[status]]: true },
        )}
      >
        {play.isCollapsed ? (
          <StatusIcon status={status} />
        ) : (
          <>
            <StatusDot status={status} />

            <Typography
              as="span"
              brand="none"
              className="truncate font-semibold"
              typographyType="body-xs"
            >
              {rowText(t, deploy)}
            </Typography>
          </>
        )}
      </StatusRowButton>
    </div>
  );
};
