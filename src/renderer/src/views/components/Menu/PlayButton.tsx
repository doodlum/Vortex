import { pathToFileURL } from "url";

import { mdiPlay } from "@mdi/js";
import React, { type FC, type ReactNode, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { Button, type IButtonBrand } from "@/ui/components/button/Button";
import { Icon } from "@/ui/components/icon/Icon";
import { Image } from "@/ui/components/image/Image";
import { Tooltip } from "@/ui/components/tooltip/Tooltip";
import { Typography } from "@/ui/components/typography/Typography";
import { joinClasses } from "@/ui/utils/joinClasses";
import type { IStarterInfo } from "@/util/StarterInfo";
import StarterInfo from "@/util/StarterInfo";

import { formatGameDisplayName } from "../Spine/utils";

/**
 * What a Deploy control that merges into Play puts on it instead of Play itself - see
 * `DeployMerged`.
 */
export interface IPlayOverride {
  label: string;
  /** Replaces the tooltip's first line; `interactive` when it holds a control. */
  details?: ReactNode;
  interactive?: boolean;
  brand?: IButtonBrand;
  iconPath?: string;
  iconClassName?: string;
  badge?: "primary" | "danger";
  busy?: boolean;
  /** Replaces Play's own action; absent while busy, which makes a click do nothing. */
  onClick?: () => void;
}

export interface IPlayButtonProps {
  primaryStarter: IStarterInfo | undefined;
  gameName: string | undefined;
  isPrimaryRunning: boolean;
  isCollapsed: boolean;
  disabled: boolean;
  override?: IPlayOverride;
  className?: string;
  onClick: () => void;
}

export const PlayButton: FC<React.PropsWithChildren<IPlayButtonProps>> = ({
  primaryStarter,
  gameName,
  isPrimaryRunning,
  isCollapsed,
  disabled,
  override,
  className,
  onClick,
}) => {
  const { t } = useTranslation();

  const launcherIconSrc = useMemo(() => {
    if (!primaryStarter) return undefined;
    try {
      const iconPath = StarterInfo.getIconPath(primaryStarter);
      if (iconPath) {
        return pathToFileURL(iconPath).href.replace("'", "%27");
      }
    } catch {
      // ignore
    }
    return undefined;
  }, [primaryStarter]);

  const label = override?.label ?? (isPrimaryRunning ? t("Running...") : t("Play"));

  /** What the button says it will do, for the tooltip's first line and the aria-label. */
  const playLabel =
    override?.label ??
    (isPrimaryRunning
      ? t("Running...")
      : gameName
        ? t("Play {{game}}", { replace: { game: formatGameDisplayName(gameName) } })
        : t("Play"));

  return (
    <div className="relative w-full">
      <Tooltip
        customContent={
          <div className="space-y-1 px-4 py-3">
            {override?.details ?? (
              <Typography
                appearance="moderate"
                as="p"
                className="font-semibold"
                typographyType="body-sm"
              >
                {playLabel}
              </Typography>
            )}

            {!!primaryStarter && (
              <>
                <Typography appearance="subdued" as="p" typographyType="body-sm">
                  {t("Launch with")}
                </Typography>

                <div className="flex items-center gap-x-1.5">
                  {!!launcherIconSrc && (
                    <Image
                      alt=""
                      className="size-5 shrink-0 rounded-xs"
                      imageType="other"
                      src={launcherIconSrc}
                    />
                  )}

                  <Typography appearance="moderate" as="span" typographyType="body-sm">
                    {primaryStarter.name}
                  </Typography>
                </div>
              </>
            )}
          </div>
        }
        interactive={override?.interactive}
        placement="right"
      >
        <Button
          aria-busy={override?.busy || undefined}
          aria-label={isCollapsed ? playLabel : undefined}
          brand={override?.brand ?? "neutral"}
          className={joinClasses([
            "w-full transition-all",
            isCollapsed ? "h-10" : "h-12",
            className,
          ])}
          customContent={
            <>
              <Icon
                className={joinClasses(["nxm-button-icon", override?.iconClassName])}
                path={override?.iconPath ?? mdiPlay}
                size="lg"
              />

              {!isCollapsed && (
                <Typography
                  appearance="inverted"
                  as="span"
                  className="font-semibold"
                  typographyType="body-lg"
                >
                  {label}
                </Typography>
              )}
            </>
          }
          data-play-badge={override?.badge}
          disabled={disabled}
          onClick={override !== undefined ? override.onClick : onClick}
        />
      </Tooltip>

      {!!override?.badge && (
        <span
          aria-hidden
          className={joinClasses(
            [
              "pointer-events-none absolute -top-1 -right-1 z-2 size-3 rounded-full border-2 border-surface-base",
            ],
            {
              "bg-primary-moderate": override.badge === "primary",
              "bg-danger-moderate": override.badge === "danger",
            },
          )}
        />
      )}
    </div>
  );
};
