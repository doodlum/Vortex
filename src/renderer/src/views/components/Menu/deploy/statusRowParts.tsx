import { mdiAlertCircleOutline, mdiCheck, mdiCircleOutline, mdiLoading } from "@mdi/js";
import React, { type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { DeployStatus } from "@/extensions/mod_management/hooks/useDeployMods.hook";
import { Icon, type IIconSize } from "@/ui/components/icon/Icon";
import { joinClasses } from "@/ui/utils/joinClasses";

import { getIconPath } from "../../iconMap";
import { deployAction, deployCopy } from "./deployCopy";
import { DeployTooltip } from "./DeployTooltip";
import type { IDeployControlProps } from "./types";

/** Each state's colour, as a dot, a text colour, a border and a tint. */
export const STATE_DOT: Record<DeployStatus, string> = {
  idle: "bg-success-moderate",
  deployed: "bg-success-moderate",
  needed: "bg-primary-moderate",
  deploying: "bg-info-moderate",
  failed: "bg-danger-moderate",
};

export const STATE_TEXT: Record<DeployStatus, string> = {
  idle: "text-neutral-subdued",
  deployed: "text-success-moderate",
  needed: "text-primary-moderate",
  deploying: "text-info-moderate",
  failed: "text-danger-moderate",
};

/** A spinner: movement that is the information, so reduced motion leaves it turning. */
export const Spinner = ({ className }: { className?: string }) => (
  <span className={joinClasses(["relative shrink-0 animate-spin", className])}>
    <Icon className="opacity-40" path={mdiCircleOutline} size="none" />

    <Icon className="absolute inset-0" path={mdiLoading} size="none" />
  </span>
);

export const StatusDot = ({ status }: { status: DeployStatus }) =>
  status === "deploying" ? (
    <Spinner className="size-3 text-info-moderate" />
  ) : (
    <span className={joinClasses(["size-2 shrink-0 rounded-full", STATE_DOT[status]])} />
  );

/** The state as a small icon: the check, the alert, the rocket, or the spinner. */
export const StatusIcon = ({ size = "sm", status }: { size?: IIconSize; status: DeployStatus }) => {
  if (status === "deploying") {
    return <Spinner className={joinClasses(["text-info-moderate"], { "size-4": size === "sm" })} />;
  }
  const path =
    status === "failed"
      ? mdiAlertCircleOutline
      : status === "deployed" || status === "idle"
        ? mdiCheck
        : getIconPath("deploy");
  return <Icon className={joinClasses(["shrink-0", STATE_TEXT[status]])} path={path} size={size} />;
};

/**
 * A thin line under a row while it deploys: determinate at the deployment's percent once
 * it says one, sliding until then. Its movement is the information, so it keeps moving
 * under reduced motion, as spinners do.
 */
export const ProgressLine = ({ percent }: { percent: number | undefined }) => (
  <span className="relative block h-0.5 w-full overflow-hidden rounded-full bg-info-950">
    <span
      className={joinClasses(["absolute inset-y-0 left-0 rounded-full bg-info-moderate"], {
        "w-1/3 animate-deploy-progress": percent === undefined,
        "w-(--deploy-progress)": percent !== undefined,
      })}
      style={
        percent === undefined
          ? undefined
          : ({ "--deploy-progress": `${Math.min(100, Math.max(0, percent))}%` } as CSSProperties)
      }
    />
  </span>
);

/**
 * The button every status row is: the shared tooltip, the state for tests and styling,
 * busy while deploying, named by the tooltip's title when collapsed, and the click each
 * state has - deploy, the failure's details, or nothing while it deploys.
 */
export const StatusRowButton = ({
  children,
  className,
  deploy,
  play,
}: IDeployControlProps & { children: ReactNode; className?: string }) => {
  const { t } = useTranslation();
  const copy = deployCopy(t, deploy);
  const { status } = deploy;

  return (
    <DeployTooltip copy={copy}>
      <button
        aria-busy={status === "deploying" || undefined}
        aria-label={play.isCollapsed ? copy.title : undefined}
        className={joinClasses(
          [
            "relative transition-colors",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-subdued",
            className,
          ],
          { "cursor-progress": status === "deploying" },
        )}
        data-deploy-state={status}
        data-testid="deploy-mods"
        type="button"
        onClick={deployAction(deploy)}
      >
        {children}
      </button>
    </DeployTooltip>
  );
};
