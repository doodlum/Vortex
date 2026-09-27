import { mdiCircleOutline, mdiLoading } from "@mdi/js";
import React from "react";
import { useTranslation } from "react-i18next";

import type { DeployStatus } from "@/extensions/mod_management/hooks/useDeployMods.hook";
import { Icon } from "@/ui/components/icon/Icon";
import { Typography } from "@/ui/components/typography/Typography";
import { joinClasses } from "@/ui/utils/joinClasses";

import { getIconPath } from "../../iconMap";
import { PlayButton } from "../PlayButton";
import { deployAction, deployCopy } from "./deployCopy";
import { DeployTooltip } from "./DeployTooltip";
import type { IDeployControlProps } from "./types";

const DOT: Record<Exclude<DeployStatus, "deploying">, string> = {
  idle: "bg-success-moderate",
  needed: "bg-primary-moderate",
  failed: "bg-danger-moderate",
};

/** The state as a coloured dot, or a spinner while deploying - which is information. */
const StatusDot = ({ status }: { status: DeployStatus }) =>
  status === "deploying" ? (
    <span className="relative size-3 shrink-0 animate-spin text-info-moderate">
      <Icon className="opacity-40" path={mdiCircleOutline} size="none" />

      <Icon className="absolute inset-0" path={mdiLoading} size="none" />
    </span>
  ) : (
    <span className={joinClasses(["size-2 shrink-0 rounded-full", DOT[status]])} />
  );

/**
 * 3, Status row: a quiet row above Play, laid out like the menu's page links - a status
 * dot, what the state is, and the rocket - that deploys when clicked. Collapsed, the
 * rocket with the dot as its badge.
 */
export const DeployStatusRow = ({ deploy, play }: IDeployControlProps) => {
  const { t } = useTranslation();
  const copy = deployCopy(t, deploy);
  const { status } = deploy;
  const collapsed = play.isCollapsed;

  const text: Record<DeployStatus, string> = {
    idle: t("Up to date"),
    needed: t("Deploy changes"),
    deploying: t("Deploying..."),
    failed: t("Deployment failed"),
  };

  return (
    <div className="flex w-full flex-col gap-y-2">
      <DeployTooltip copy={copy}>
        <button
          aria-busy={status === "deploying" || undefined}
          aria-label={collapsed ? copy.title : undefined}
          className={joinClasses(
            [
              "relative flex h-9 w-full items-center rounded-lg transition-colors",
              "hover:bg-surface-mid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-subdued",
              collapsed ? "justify-center" : "gap-x-3 px-3",
            ],
            {
              "text-neutral-subdued hover:text-neutral-moderate": status === "idle",
              "text-neutral-moderate": status === "needed" || status === "deploying",
              "text-danger-moderate": status === "failed",
              "cursor-progress": status === "deploying",
            },
          )}
          data-deploy-state={status}
          data-testid="deploy-mods"
          type="button"
          onClick={deployAction(deploy)}
        >
          {collapsed ? (
            <>
              <Icon
                className={joinClasses({ "animate-rocket-lift": status === "deploying" })}
                path={getIconPath("deploy")}
                size="sm"
              />

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
                {text[status]}
              </Typography>

              <Icon
                className={joinClasses([
                  "shrink-0",
                  {
                    "animate-rocket-lift": status === "deploying",
                    "text-primary-moderate": status === "needed",
                  },
                ])}
                path={getIconPath("deploy")}
                size="sm"
              />
            </>
          )}
        </button>
      </DeployTooltip>

      <PlayButton {...play} />
    </div>
  );
};
