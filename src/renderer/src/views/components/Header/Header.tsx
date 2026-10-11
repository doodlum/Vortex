import React, { type FC, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useSelector } from "react-redux";

import { useWindowContext } from "@/contexts";
import { Button } from "@/ui/components/button/Button";
import { Tooltip } from "@/ui/components/tooltip/Tooltip";
import { Typography } from "@/ui/components/typography/Typography";
import { nxmPanelClose, nxmPanelOpen } from "@/ui/icon-paths";

import {
  activeProfile as activeProfileSelector,
  gameProfiles as gameProfilesSelector,
  knownGames as knownGamesSelector,
} from "../../../util/selectors";
import { useSpineContext } from "../Spine/SpineContext";
import { PremiumIndicator } from "./premium/PremiumIndicator";
import { ProfileSection } from "./profile/ProfileSection";
import { StagingIndicator } from "./StagingIndicator";
import { VersionIndicator } from "./VersionIndicator";
import { WindowControls } from "./WindowControls";

export const Header: FC<React.PropsWithChildren<unknown>> = () => {
  const { menuIsCollapsed, setMenuIsCollapsed } = useWindowContext();
  const { t } = useTranslation();
  const { selection } = useSpineContext();
  const knownGames = useSelector(knownGamesSelector);
  const activeProfile = useSelector(activeProfileSelector);
  const gameProfiles = useSelector(gameProfilesSelector);

  const title = useMemo(() => {
    if (selection.type === "home") {
      return t("Home");
    }
    if (selection.type === "downloads") {
      return t("Downloads");
    }
    const game = knownGames.find((g) => g.id === selection.gameId);
    return game?.name ?? t("Home");
  }, [selection, knownGames, t]);

  const handleToggleMenu = useCallback(() => {
    setMenuIsCollapsed((prev) => !prev);
  }, [setMenuIsCollapsed]);

  const profileName = useMemo(() => {
    if (selection.type !== "game" || !activeProfile) {
      return undefined;
    }
    return gameProfiles.length > 1 ? activeProfile.name : undefined;
  }, [selection, activeProfile, gameProfiles]);

  return (
    <div
      className="grid h-11 shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(max-content,1fr)] items-center gap-x-6 [-webkit-app-region:drag] has-aria-expanded:[-webkit-app-region:no-drag]"
      data-testid="window-titlebar"
    >
      <div className="flex min-w-0 items-center gap-x-1 pl-4.5">
        <Tooltip content={menuIsCollapsed ? t("Open menu") : t("Collapse menu")} placement="right">
          <Button
            appearance="weak"
            aria-label={menuIsCollapsed ? t("Open menu") : t("Collapse menu")}
            brand="neutral"
            className="[-webkit-app-region:no-drag]"
            leftIconPath={menuIsCollapsed ? nxmPanelOpen : nxmPanelClose}
            onClick={handleToggleMenu}
          />
        </Tooltip>

        <Typography
          brand="none"
          className="flex grow items-center gap-x-2 overflow-hidden font-semibold whitespace-nowrap"
        >
          <span className="truncate text-neutral-strong">{title}</span>

          {!!profileName && (
            <span className="shrink-9999 truncate text-neutral-subdued">{profileName}</span>
          )}
        </Typography>
      </div>

      <VersionIndicator />

      <div className="flex shrink-0 items-center gap-x-5 justify-self-end [-webkit-app-region:no-drag]">
        <div className="flex items-center gap-x-2">
          <ProfileSection />

          <PremiumIndicator />

          <StagingIndicator />
        </div>

        <WindowControls />
      </div>
    </div>
  );
};
