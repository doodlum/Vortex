import { mdiRefresh } from "@mdi/js";
import { unknownToError } from "@vortex/shared";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDispatch, useSelector } from "react-redux";

import type { IExtensionApi } from "@/types/IExtensionContext";
import type { IState } from "@/types/IState";
import { Button } from "@/ui/components/button/Button";
import { Picker } from "@/ui/components/picker/Picker";
import { Typography } from "@/ui/components/typography/Typography";
import { inspectPrefix, listInstalledProton } from "@/util/linux/proton";
import type { IInstalledProton, IPrefixInventory } from "@/util/linux/proton";
import { findLinuxSteamPath } from "@/util/linux/steamPaths";
import { useSteamGamesRevision } from "@/util/linux/steamRevision";
import Steam from "@/util/Steam";
import { Page } from "@/views/components/Page/Page";
import { PageHeader } from "@/views/components/Page/PageHeader";
import { PageScroll } from "@/views/components/Page/PageScroll";

import { setFeature } from "../../profile_management/actions/profiles";
import { activeProfile } from "../../profile_management/selectors";
import { detectModRuntimeDependencies } from "../modRequirements";
import { activeProtonGame } from "../selection";

interface IProtonPageProps {
  api: IExtensionApi;
  active?: boolean;
}
interface IPageData {
  tools: IInstalledProton[];
  inventory?: IPrefixInventory;
  hints: string[];
}

export const ProtonPage = ({ active, api }: IProtonPageProps) => {
  const { t } = useTranslation(["common"]);
  const dispatch = useDispatch();
  const profile = useSelector(activeProfile);
  useSteamGamesRevision();
  useSelector((state: IState) => state.settings.gameMode.discovered);
  const entry = activeProtonGame(api.getState());
  const [data, setData] = useState<IPageData>({ tools: [], hints: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const generation = useRef(0);
  const selected =
    typeof profile?.features?.["proton-version"] === "string"
      ? (profile.features["proton-version"] as string)
      : "";

  const refresh = useCallback(async () => {
    const request = ++generation.current;
    setLoading(true);
    setError(undefined);
    setData({ tools: [], hints: [] });
    try {
      const steamPath = findLinuxSteamPath();
      if (steamPath === undefined || entry === undefined || profile === undefined) return;
      const [tools, inventory, hints] = await Promise.all([
        listInstalledProton(steamPath),
        entry.compatDataPath === undefined ? undefined : inspectPrefix(entry.compatDataPath),
        detectModRuntimeDependencies(api.getState(), profile),
      ]);
      if (request === generation.current) setData({ tools, inventory, hints });
    } catch (err) {
      if (request === generation.current) setError(unknownToError(err).message);
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }, [api, entry, profile]);

  useEffect(() => {
    if (active !== false) void refresh();
    return () => {
      generation.current += 1;
    };
  }, [active, refresh]);

  const refreshSteam = async () => {
    setLoading(true);
    setError(undefined);
    try {
      await Steam.reloadGames();
    } catch (err) {
      setError(unknownToError(err).message);
    } finally {
      setLoading(false);
    }
  };

  const options = [
    { label: t("Use Steam's selected Proton"), value: "" },
    ...data.tools.map((tool) => ({ label: tool.name, value: tool.path })),
  ];
  if (selected !== "" && !options.some((option) => option.value === selected)) {
    options.push({
      label: t("Selected Proton is unavailable: {{path}}", { path: selected }),
      value: selected,
    });
  }

  return (
    <Page active={active} pageId="proton-page" scrollable={false}>
      <PageHeader title={t("Proton")}>
        <Button disabled={loading} leftIconPath={mdiRefresh} onClick={() => void refreshSteam()}>
          {t("Refresh")}
        </Button>
      </PageHeader>
      <PageScroll>
        <div className="space-y-6 p-6">
          {error !== undefined && <Typography role="alert">{error}</Typography>}
          {entry === undefined ? (
            <Typography>
              {t("Select a Steam game using Proton to manage its compatibility settings.")}
            </Typography>
          ) : (
            <>
              <section className="space-y-3 rounded-lg border border-stroke-weak p-6">
                <Typography as="h3" typographyType="heading-sm">
                  {t("Proton version")}
                </Typography>
                <Typography>
                  {t(
                    "Choose the Proton runtime for games and tools launched by Vortex in this profile. Steam's own launch settings stay under Steam's control.",
                  )}
                </Typography>
                <Picker
                  disabled={loading || profile === undefined}
                  options={options}
                  value={selected}
                  onChange={(value) => {
                    if (profile !== undefined)
                      dispatch(setFeature(profile.id, "proton-version", value));
                  }}
                />
                <Typography className="break-all">
                  {t("Steam runtime: {{path}}", {
                    path: entry.protonPath ?? t("Not installed or unavailable"),
                  })}
                </Typography>
              </section>
              <section className="space-y-3 rounded-lg border border-stroke-weak p-6">
                <Typography as="h3" typographyType="heading-sm">
                  {t("Game prefix")}
                </Typography>
                <Typography className="break-all">
                  {entry.compatDataPath ??
                    t("Launch this game in Steam once to initialise its prefix.")}
                </Typography>
                <Typography>
                  {t("Winetricks records: {{items}}", {
                    items: data.inventory?.winetricks.join(", ") || t("None recorded"),
                  })}
                </Typography>
                <Typography>
                  {t("Runtime file indicators: {{items}}", {
                    items: data.inventory?.components.join(", ") || t("None found"),
                  })}
                </Typography>
                <Typography>
                  {t(
                    "File indicators can include Wine built-ins and do not prove that a native Windows runtime is installed.",
                  )}
                </Typography>
              </section>
              <section className="space-y-3 rounded-lg border border-stroke-weak p-6">
                <Typography as="h3" typographyType="heading-sm">
                  {t("Mod runtime hints")}
                </Typography>
                <Typography>
                  {data.hints.join(", ") || t("No runtime hints found in enabled mods.")}
                </Typography>
                <Typography>
                  {t(
                    "These hints come from executable bytes. Check each mod's installation instructions before changing the prefix. Use Protontricks for this game's Steam App ID: {{appId}}.",
                    { appId: entry.appid },
                  )}
                </Typography>
              </section>
            </>
          )}
        </div>
      </PageScroll>
    </Page>
  );
};
