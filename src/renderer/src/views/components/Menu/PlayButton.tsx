import { pathToFileURL } from "url";

import { mdiPlay } from "@mdi/js";
import React, { type FC, type ReactNode, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/ui/components/button/Button";
import { Icon } from "@/ui/components/icon/Icon";
import { Image } from "@/ui/components/image/Image";
import { Tooltip } from "@/ui/components/tooltip/Tooltip";
import { Typography } from "@/ui/components/typography/Typography";
import { joinClasses } from "@/ui/utils/joinClasses";
import type { IStarterInfo } from "@/util/StarterInfo";
import StarterInfo from "@/util/StarterInfo";

import { formatGameDisplayName } from "../Spine/utils";

/**
 * How Play is held back while a deployment is pending - see `playGate.ts`. Play keeps its
 * size and place; what it says, shows and does on a click change.
 */
export interface IPlayGate {
  /** Why, for the tooltip and for screen readers: the pending deployment's messages. */
  reason: ReactNode;
  /** Its name while held back, which says why. */
  ariaLabel: string;
  /** Looks and announces as unavailable (`aria-disabled`); focus and the tooltip remain. */
  inert?: boolean;
  label?: string;
  iconPath?: string;
  busy?: boolean;
  /** Replaces Play's own action; absent, a click does nothing. */
  onClick?: () => void;
}

/** Play, as ToolsSection has always drawn it; the Deploy control draws its status row above. */
export interface IPlayButtonProps {
  primaryStarter: IStarterInfo | undefined;
  gameName: string | undefined;
  isPrimaryRunning: boolean;
  isCollapsed: boolean;
  disabled: boolean;
  gate?: IPlayGate;
  onClick: () => void;
}

export const PlayButton: FC<React.PropsWithChildren<IPlayButtonProps>> = ({
  primaryStarter,
  gameName,
  isPrimaryRunning,
  isCollapsed,
  disabled,
  gate,
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

  const label = gate?.label ?? (isPrimaryRunning ? t("Running...") : t("Play"));

  /** What the button says it will do, for the tooltip's first line and the aria-label. */
  const playLabel = isPrimaryRunning
    ? t("Running...")
    : gameName
      ? t("Play {{game}}", { replace: { game: formatGameDisplayName(gameName) } })
      : t("Play");

  return (
    <div className="relative w-full">
      <Tooltip
        customContent={
          <div className="space-y-1 px-4 py-3">
            {gate?.reason ?? (
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
        placement="right"
      >
        <Button
          aria-busy={gate?.busy || undefined}
          aria-disabled={gate?.inert || undefined}
          aria-label={gate !== undefined ? gate.ariaLabel : isCollapsed ? playLabel : undefined}
          brand="neutral"
          className={joinClasses(["w-full transition-all", isCollapsed ? "h-10" : "h-12"])}
          customContent={
            <>
              <Icon className="nxm-button-icon" path={gate?.iconPath ?? mdiPlay} size="lg" />

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
          data-play-gate={gate === undefined ? undefined : gate.inert ? "inert" : "active"}
          disabled={disabled}
          onClick={gate !== undefined ? gate.onClick : onClick}
        />
      </Tooltip>
    </div>
  );
};
