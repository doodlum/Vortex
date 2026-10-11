import { mdiAlertOutline, mdiAutorenew, mdiCheck } from "@mdi/js";
import React from "react";
import { useTranslation } from "react-i18next";

import type { IDeploymentFeedback } from "@/extensions/mod_management/util/deploymentFeedback";
import { Button } from "@/ui/components/button/Button";
import { Icon } from "@/ui/components/icon/Icon";
import { Tooltip } from "@/ui/components/tooltip/Tooltip";
import { Typography } from "@/ui/components/typography/Typography";
import { joinClasses } from "@/ui/utils/joinClasses";

interface IApplyButtonProps {
  isCollapsed: boolean;
  feedback?: IDeploymentFeedback;
  onShowFailure?: () => void;
  /** 0-100 while a deployment runs; undefined when idle. */
  progress?: number;
  /** What the deploy is doing, e.g. the mod it's on, shown under the tooltip while applying. */
  step?: string;
  onClick: () => void;
}

const Content = ({
  isApplying = false,
  isCollapsed,
  label,
  icon = mdiAutorenew,
}: {
  isApplying?: boolean;
  isCollapsed: boolean;
  label: string;
  icon?: string;
}) => (
  <>
    <Icon
      className={joinClasses([
        "nxm-button-icon",
        { "animate-spin reduce-motion:animate-none": isApplying },
      ])}
      path={icon}
      size="lg"
    />

    {!isCollapsed && (
      <Typography
        // While applying the bar sets the colour, so the text picks it up from there.
        {...(isApplying ? { brand: "none" as const } : { appearance: "inverted" as const })}
        as="span"
        className="min-w-0 font-semibold break-words whitespace-normal"
        typographyType="body-lg"
      >
        {label}
      </Typography>
    )}
  </>
);

/**
 * Deploys pending mod changes. Shown beside Play only while there is something to deploy.
 * While it deploys, the whole button becomes a progress bar: not a button at all, so it has
 * no hover or press state and can't start a second deployment.
 */
export const ApplyButton = ({
  isCollapsed,
  progress,
  step,
  feedback,
  onClick,
  onShowFailure,
}: IApplyButtonProps) => {
  const { t } = useTranslation();
  const isApplying = progress !== undefined;
  const failed = !isApplying && feedback?.state === "failed";
  const deployed = !isApplying && feedback?.state === "deployed";
  const label = isApplying
    ? t("Applying")
    : failed
      ? t("Deployment failed")
      : deployed
        ? t("Mods deployed")
        : t("Apply");
  const showStep = isApplying && !!step;
  const height = isCollapsed ? "h-10" : "h-12";

  const headline = failed
    ? t(feedback.error?.title ?? "Deployment failed")
    : deployed
      ? t("Mods deployed")
      : !isApplying
        ? t("Apply your mod changes to the game")
        : showStep
          ? t("Applying mod changes")
          : t("Applying mod changes…");

  return (
    <div className={joinClasses(["relative", isCollapsed ? "w-full" : "min-w-0 flex-1"])}>
      <Tooltip
        closeOnPress={false}
        customContent={
          <div className="nxm-tooltip-content space-y-0.5">
            <p>{headline}</p>

            {showStep && <p className="truncate text-neutral-subdued">{step}</p>}
          </div>
        }
        placement="right"
      >
        {isApplying ? (
          <div
            aria-label={label}
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={progress}
            className={joinClasses([
              "relative flex w-full cursor-progress items-center justify-center gap-x-2 overflow-hidden rounded-sm bg-primary-600/80 px-2 text-primary-950",
              height,
            ])}
            data-testid="menu-apply"
            role="progressbar"
          >
            <div
              className="absolute inset-y-0 left-0 bg-primary-moderate transition-[width] duration-300 reduce-motion:duration-0"
              style={{ width: `${progress}%` }}
            />

            <span className="relative flex items-center gap-x-2">
              <Content isApplying isCollapsed={isCollapsed} label={label} />
            </span>
          </div>
        ) : deployed ? (
          <div
            aria-label={label}
            className={joinClasses([
              "flex w-full items-center justify-center gap-x-2 rounded-sm bg-success-weak px-2 text-success-strong",
              height,
            ])}
            data-testid="menu-apply"
            role="status"
          >
            <Icon path={mdiCheck} size="lg" />
            {!isCollapsed && <span className="font-semibold">{label}</span>}
            {isCollapsed && <span className="sr-only">{label}</span>}
          </div>
        ) : (
          <Button
            aria-label={label}
            brand={failed ? "danger" : "primary"}
            className={joinClasses(["w-full transition-all", height])}
            customContent={
              <Content
                icon={failed ? mdiAlertOutline : mdiAutorenew}
                isCollapsed={isCollapsed}
                label={label}
              />
            }
            data-testid="menu-apply"
            onClick={failed ? onShowFailure : onClick}
          />
        )}
      </Tooltip>
    </div>
  );
};
