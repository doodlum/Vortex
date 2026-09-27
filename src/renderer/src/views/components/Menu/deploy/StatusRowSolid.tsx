import { mdiAlertCircleOutline, mdiCheck } from "@mdi/js";
import React from "react";
import { useTranslation } from "react-i18next";

import type { DeployStatus } from "@/extensions/mod_management/hooks/useDeployMods.hook";
import { Icon } from "@/ui/components/icon/Icon";
import { Typography } from "@/ui/components/typography/Typography";
import { joinClasses } from "@/ui/utils/joinClasses";

import { getIconPath } from "../../iconMap";
import { rowText } from "./deployCopy";
import { Spinner, StatusRowButton } from "./statusRowParts";
import type { IDeployControlProps } from "./types";

/**
 * The fills and hovers of the design system's strong buttons (button.css), with their
 * text colour, neutral-inverted, on every one of them.
 */
const SOLID: Record<DeployStatus, string> = {
  idle: "bg-neutral-strong hover:bg-neutral-subdued",
  deployed: "bg-success-moderate hover:bg-success-strong",
  needed: "bg-primary-moderate hover:bg-primary-strong",
  deploying: "bg-info-moderate",
  failed: "bg-danger-moderate hover:bg-danger-strong",
};

const ICON: Record<Exclude<DeployStatus, "deploying">, string> = {
  idle: mdiCheck,
  deployed: mdiCheck,
  needed: getIconPath("deploy"),
  failed: mdiAlertCircleOutline,
};

/**
 * Status row 4, Solid: Tint's layout as a filled component - the state's strong fill with
 * dark text and icons, as the design system's strong buttons draw them. Collapsed, a
 * filled square with the icon.
 */
export const StatusRowSolid = (props: IDeployControlProps) => {
  const { t } = useTranslation();
  const { deploy, play } = props;
  const { status } = deploy;

  return (
    <StatusRowButton
      {...props}
      className={joinClasses(
        [
          "flex h-9 w-full items-center rounded-lg text-neutral-inverted",
          play.isCollapsed ? "justify-center" : "gap-x-3 px-3",
        ],
        { [SOLID[status]]: true },
      )}
    >
      {status === "deploying" ? (
        <Spinner className="size-4" />
      ) : (
        <Icon className="shrink-0" path={ICON[status]} size="sm" />
      )}

      {!play.isCollapsed && (
        <Typography
          as="span"
          brand="none"
          className="grow truncate text-left font-semibold"
          typographyType="body-sm"
        >
          {rowText(t, deploy)}
        </Typography>
      )}
    </StatusRowButton>
  );
};
