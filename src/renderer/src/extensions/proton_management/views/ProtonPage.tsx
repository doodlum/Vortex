import * as os from "os";
import * as path from "path";

import {
  mdiDeleteSweep,
  mdiDownload,
  mdiRefresh,
  mdiThumbDownOutline,
  mdiThumbUpOutline,
} from "@mdi/js";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDispatch, useSelector } from "react-redux";

import ProgressBar from "@/controls/ProgressBar";
import type { IExtensionApi } from "@/types/IExtensionContext";
import { Button } from "@/ui/components/button/Button";
import { Switch } from "@/ui/components/form/switch/Switch";
import { Picker } from "@/ui/components/picker/Picker";
import { Typography } from "@/ui/components/typography/Typography";
import GameStoreHelper from "@/util/GameStoreHelper";
import { inspectPrefix, listInstalledProton } from "@/util/linux/proton";
import { findLinuxSteamPath } from "@/util/linux/steamPaths";
import type { ISteamEntry, Steam } from "@/util/Steam";
import { useRelativeTime } from "@/util/useRelativeTime";
import { Page } from "@/views/components/Page/Page";
import { PageHeader } from "@/views/components/Page/PageHeader";
import { PageScroll } from "@/views/components/Page/PageScroll";

import { setFeature } from "../../profile_management/actions/profiles";
import { activeProfile } from "../../profile_management/selectors";
import { installDependencies } from "../dependencyInstaller";
import { detectModRuntimeDependencies } from "../modRequirements";
import {
  clearModShaderCache,
  inspectModShaderCache,
  inspectPrivateShaderCache,
  resetPrivateShaderCache,
  type IModShaderCacheInfo,
  type IPrivateShaderCacheInfo,
} from "../shaderCache";
import {
  disableShaderCacheRedirect,
  enableShaderCacheRedirect,
  getSteamLaunchOptions,
  SHADER_CACHE_WRAPPER,
  setSteamLaunchOptions,
  shaderCacheInvocation,
} from "../steamShaderSettings";

interface IProtonPageProps {
  api: IExtensionApi;
  active?: boolean;
}

interface IPageData {
  appId?: string;
  required: string[];
  tools: Array<{ label: string; value: string }>;
  components: string[];
  shaderCache: IModShaderCacheInfo;
  shaderRoots: string[];
  steamShaderRoots: string[];
  privateShaderCache?: IPrivateShaderCacheInfo;
}

const EMPTY_DATA: IPageData = {
  components: [],
  required: [],
  shaderCache: { bytes: 0, files: 0 },
  shaderRoots: [],
  steamShaderRoots: [],
  tools: [],
};

const formatBytes = (bytes: number): string => {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
};

const LastUpdated = ({ timestamp }: { timestamp?: number }) => {
  const { t } = useTranslation(["common"]);
  const time = useRelativeTime(timestamp, t);

  if (time === undefined) return null;

  return (
    <Typography appearance="subdued" brand="neutral-translucent" typographyType="body-sm">
      {t("Last updated: {{time}}", { time })}
    </Typography>
  );
};

export const ProtonPage = ({ active, api }: IProtonPageProps) => {
  const { t } = useTranslation(["common"]);
  const dispatch = useDispatch();
  const profile = useSelector(activeProfile);
  const toolsRunning = useSelector((state: any) => state.session.base.toolsRunning);
  const [data, setData] = useState<IPageData>(EMPTY_DATA);
  const [loading, setLoading] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<number>();
  const [cacheRedirectEnabled, setCacheRedirectEnabled] = useState<boolean>();
  const [steamLaunchOptions, setSteamLaunchOptionsState] = useState("");
  const [steamSettingsAvailable, setSteamSettingsAvailable] = useState(true);
  const [dependencyProgress, setDependencyProgress] = useState<number>();
  const [dependencyStatus, setDependencyStatus] = useState<string>();
  const selected = profile?.features?.["proton-version"] ?? "";
  const automatic = profile?.features?.["proton-auto-dependencies"] !== false;
  const pageFeedback = profile?.features?.["proton-page-feedback"] as string | undefined;

  const givePageFeedback = useCallback(
    (helpful: boolean) => {
      if (profile === undefined) return;
      dispatch(setFeature(profile.id, "proton-page-feedback", helpful ? "helpful" : "not-helpful"));
      api.sendNotification({
        type: "success",
        message: helpful
          ? "Thanks for letting us know this page was helpful"
          : "Thanks — your feedback will help us improve this page",
        displayMS: 4000,
      });
    },
    [api, dispatch, profile],
  );

  const refresh = useCallback(async () => {
    if (profile === undefined) return;
    setLoading(true);
    try {
      const steamPath = findLinuxSteamPath();
      if (steamPath === undefined) {
        setData(EMPTY_DATA);
        return;
      }
      const discovery = api.getState().settings.gameMode.discovered[profile.gameId];
      const steam = GameStoreHelper.getGameStore("steam") as Steam;
      const games = await steam.allGames();
      const entry: ISteamEntry | undefined = games.find((game) =>
        discovery?.path?.toLowerCase().startsWith(game.gamePath.toLowerCase()),
      );
      const tools = await listInstalledProton(steamPath);
      const inventory = entry?.compatDataPath
        ? await inspectPrefix(entry.compatDataPath)
        : undefined;
      const required = await detectModRuntimeDependencies(api.getState(), profile);
      const steamShaderRoots =
        entry === undefined
          ? []
          : [
              ...new Set([
                path.join(steamPath, "steamapps", "shadercache"),
                path.join(path.dirname(path.dirname(entry.gamePath)), "shadercache"),
              ]),
            ];
      let redirectEnabled = false;
      try {
        if (entry === undefined) throw new Error("Steam game is unavailable");
        const launchOptions = await getSteamLaunchOptions(entry.appid);
        setSteamLaunchOptionsState(launchOptions);
        redirectEnabled = launchOptions.includes(
          shaderCacheInvocation(entry.appid, SHADER_CACHE_WRAPPER),
        );
        setCacheRedirectEnabled(redirectEnabled);
        setSteamSettingsAvailable(true);
      } catch {
        setCacheRedirectEnabled(undefined);
        setSteamSettingsAvailable(false);
      }
      const shaderRoots = redirectEnabled
        ? [path.join(os.homedir(), ".cache", "vortex", "shadercache")]
        : steamShaderRoots;
      const shaderCache =
        entry === undefined
          ? EMPTY_DATA.shaderCache
          : await inspectModShaderCache(shaderRoots, entry.appid);
      const privateShaderCache =
        entry === undefined || !redirectEnabled
          ? undefined
          : await inspectPrivateShaderCache(shaderRoots[0], entry.appid);
      setData({
        appId: entry?.appid,
        required,
        tools: tools.map((tool) => ({ label: tool.name, value: tool.path })),
        components: inventory?.components ?? [],
        shaderCache,
        shaderRoots,
        steamShaderRoots,
        privateShaderCache,
      });
    } finally {
      setLastUpdated(Date.now());
      setLoading(false);
    }
  }, [api, profile]);

  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);

  const options = useMemo(
    () => [{ label: t("Steam default"), value: "" }, ...data.tools],
    [data.tools, t],
  );

  const changeVersion = useCallback(
    (value: string) => {
      if (profile !== undefined) dispatch(setFeature(profile.id, "proton-version", value));
    },
    [dispatch, profile],
  );

  const missing = useMemo(
    () => data.required.filter((verb) => !data.components.includes(verb)),
    [data.components, data.required],
  );

  const satisfyDependencies = useCallback(async () => {
    if (data.appId === undefined || missing.length === 0) return;
    const result = await api.showDialog(
      "question",
      "Install Windows dependencies",
      {
        text: "Vortex detected missing runtime components from the installed executables.",
        message: missing.join(", "),
      },
      [{ label: "Cancel" }, { label: "Install" }],
    );
    if (result.action !== "Install") return;
    setLoading(true);
    setDependencyProgress(0);
    setDependencyStatus("Preparing dependency installation");
    try {
      await installDependencies(api, data.appId, missing, (progress, message) => {
        setDependencyProgress(progress);
        setDependencyStatus(message);
      });
      setDependencyStatus("Verifying installed components");
      await refresh();
    } catch (err) {
      api.showErrorNotification("Failed to install Windows dependencies", err);
    } finally {
      setDependencyProgress(undefined);
      setDependencyStatus(undefined);
      setLoading(false);
    }
  }, [api, data.appId, missing, refresh]);

  const changeAutomatic = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      if (profile !== undefined) {
        dispatch(setFeature(profile.id, "proton-auto-dependencies", event.target.checked));
      }
    },
    [dispatch, profile],
  );

  const clearShaderCache = useCallback(async () => {
    if (data.appId === undefined) return;
    if (Object.keys(toolsRunning).length > 0) {
      api.sendNotification({
        type: "info",
        message: "Exit the game and its tools before resetting the shader cache",
        displayMS: 5000,
      });
      return;
    }
    const isolated = cacheRedirectEnabled === true;
    const action = "Reset cache";
    const result = await api.showDialog(
      "question",
      "Reset shader cache",
      {
        text: isolated
          ? "Vortex will discard this game's private cache, then immediately copy Steam's current shader cache into a clean replacement."
          : "Vortex will remove shaders generated by the currently deployed game and mods. They will be rebuilt next time you play, which may briefly cause stutter.",
        message:
          "Steam downloads, precompiled shader databases, mods, and game files are preserved.",
      },
      [{ label: "Cancel" }, { label: action }],
    );
    if (result.action !== action) return;
    setLoading(true);
    try {
      if (isolated) {
        if (data.steamShaderRoots.length === 0 || data.shaderRoots[0] === undefined) {
          throw new Error("Shader cache paths are unavailable");
        }
        await resetPrivateShaderCache(
          SHADER_CACHE_WRAPPER,
          data.steamShaderRoots,
          data.shaderRoots[0],
          data.appId,
        );
        api.sendNotification({
          type: "success",
          message: "Shader cache reset from Steam",
          displayMS: 5000,
        });
      } else {
        const removed = await clearModShaderCache(data.shaderRoots, data.appId);
        api.sendNotification({
          type: "success",
          message: `Cleared ${removed} mod shader cache files`,
          displayMS: 5000,
        });
      }
      await refresh();
    } catch (err) {
      api.showErrorNotification("Failed to reset shader cache", err);
    } finally {
      setLoading(false);
    }
  }, [
    api,
    cacheRedirectEnabled,
    data.appId,
    data.shaderCache.files,
    data.shaderRoots,
    data.steamShaderRoots,
    refresh,
    toolsRunning,
  ]);

  const changeCacheRedirect = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      if (data.appId === undefined) return;
      const enable = event.target.checked;
      const confirmation = enable ? "Enable isolation" : "Disable isolation";
      const result = await api.showDialog(
        "question",
        enable ? "Isolate mod shader cache" : "Disable shader-cache isolation",
        {
          text: enable
            ? "The game will start from a copy of Steam's cache and write mod-specific shaders only to the private copy."
            : "The game will return to Steam's shared cache on its next launch.",
          message: enable
            ? "If Steam updates its cache, Vortex automatically discards the old private copy and seeds a new one. Steam files and mods are never deleted."
            : "The existing private cache is preserved until you clear it.",
        },
        [{ label: "Cancel" }, { label: confirmation }],
      );
      if (result.action !== confirmation) return;
      setLoading(true);
      try {
        const next = enable
          ? enableShaderCacheRedirect(steamLaunchOptions, data.appId, SHADER_CACHE_WRAPPER)
          : disableShaderCacheRedirect(steamLaunchOptions, data.appId, SHADER_CACHE_WRAPPER);
        await setSteamLaunchOptions(data.appId, next);
        if (profile !== undefined) {
          dispatch(setFeature(profile.id, "proton-shader-cache-isolation", enable));
        }
        setSteamLaunchOptionsState(next);
        setCacheRedirectEnabled(enable);
        api.sendNotification({
          type: "success",
          message: enable ? "Mod shader cache isolated" : "Shader-cache isolation disabled",
          displayMS: 5000,
        });
      } catch (err) {
        api.showErrorNotification("Failed to change shader-cache isolation", err);
      } finally {
        setLoading(false);
      }
    },
    [api, data.appId, dispatch, profile, steamLaunchOptions],
  );

  return (
    <Page active={active} pageId="proton" scrollable={false}>
      <PageHeader
        pictogramName="proton"
        subtitle={t("Make Windows games and their mods work correctly on Linux.")}
        title={t("Proton")}
      >
        <div className="flex shrink-0 items-center gap-x-2">
          <LastUpdated timestamp={lastUpdated} />
          <Button
            appearance="subdued"
            brand="neutral"
            isLoading={loading}
            leftIconPath={mdiRefresh}
            size="sm"
            title={t("Refresh")}
            onClick={refresh}
          />
        </div>
      </PageHeader>
      <PageScroll className="flex flex-col gap-6 p-6">
        <section className="rounded-lg border border-stroke-weak bg-surface-low p-6">
          <Typography as="h3" typographyType="heading-sm">
            {t("Windows compatibility")}
          </Typography>
          <Typography appearance="subdued" className="mt-2">
            {t(
              "Choose the Proton version Steam uses to run this profile's game and mod tools. Leave this on Steam default unless a mod or troubleshooting guide requires another version.",
            )}
          </Typography>
          <Picker
            button={{ className: "min-w-64 justify-between" }}
            className="mt-4 w-fit"
            options={options}
            value={selected}
            onChange={changeVersion}
          />
          <div className="mt-6 flex items-center justify-between gap-4 border-t border-stroke-weak pt-4">
            <div>
              <Typography typographyType="body-sm">
                {t("Install required components automatically")}
              </Typography>
              <Typography appearance="subdued" typographyType="body-sm">
                {t(
                  "When installed mods need extra Windows software, Vortex detects and installs it before launch. This only adds components required by the active mods.",
                )}
              </Typography>
            </div>
            <Switch
              aria-label={t("Install required Windows components automatically")}
              checked={automatic}
              onChange={changeAutomatic}
            />
          </div>
        </section>
        <section className="rounded-lg border border-stroke-weak bg-surface-low p-6">
          <div className="flex items-center justify-between gap-4">
            <div>
              <Typography as="h3" typographyType="heading-sm">
                {t("Mod requirements")}
              </Typography>
              <Typography appearance="subdued" className="mt-2">
                {t(
                  "Vortex checks installed mods for Windows components they need, such as Visual C++ or .NET runtimes.",
                )}
              </Typography>
              <Typography appearance="subdued" className="mt-2" typographyType="body-sm">
                {t(
                  "Vortex manages Protontricks for you. It installs or updates the helper, applies only the components detected from your mods, and verifies the game prefix afterward.",
                )}
              </Typography>
            </div>
            <Button
              disabled={missing.length === 0 || data.appId === undefined}
              leftIconPath={mdiDownload}
              onClick={satisfyDependencies}
            >
              {missing.length === 0
                ? t("All requirements installed")
                : t("Install requirements ({{count}})", { count: missing.length })}
            </Button>
          </div>
          {dependencyProgress !== undefined && (
            <div className="mt-4">
              <Typography typographyType="body-sm">{t(dependencyStatus ?? "Working")}</Typography>
              <ProgressBar max={100} min={0} now={dependencyProgress} />
            </div>
          )}
          {missing.length > 0 && (
            <div className="mt-6">
              <Typography appearance="subdued">{t("Still needed by your mods")}</Typography>
              <div className="mt-2 flex flex-wrap gap-2">
                {missing.map((item) => (
                  <span
                    className="rounded-full bg-warning-subdued px-3 py-1 text-body-sm"
                    key={item}
                  >
                    {item}
                  </span>
                ))}
              </div>
            </div>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            {data.components.length > 0 ? (
              data.components.map((item) => (
                <span className="rounded-full bg-surface-mid px-3 py-1 text-body-sm" key={item}>
                  {item}
                </span>
              ))
            ) : (
              <Typography appearance="subdued">
                {t("No additional Windows components are installed for this game.")}
              </Typography>
            )}
          </div>
        </section>
        <section className="rounded-lg border border-stroke-weak bg-surface-low p-6">
          <div className="flex items-center justify-between gap-4">
            <div>
              <Typography as="h3" typographyType="heading-sm">
                {t("Mod shader cache")}
              </Typography>
              <Typography appearance="subdued" className="mt-2">
                {t(
                  "Mods can change shaders while you play. Vortex gives this game a private copy of Steam's shader cache so those changes cannot alter Steam's original cache or make Steam replace it.",
                )}
              </Typography>
              <Typography appearance="subdued" className="mt-2" typographyType="body-sm">
                {cacheRedirectEnabled
                  ? t("Protection is on. The game reads and writes only its private cache.")
                  : t("Protection is off. The game may write modded shaders into Steam's cache.")}
              </Typography>
            </div>
            <Button
              disabled={data.appId === undefined || Object.keys(toolsRunning).length > 0}
              leftIconPath={mdiDeleteSweep}
              onClick={clearShaderCache}
            >
              {t("Reset cache")}
            </Button>
          </div>
          <div className="mt-4 flex items-center justify-between gap-4 border-t border-stroke-weak pt-4">
            <div>
              <Typography typographyType="body-sm">{t("Protect Steam's shader cache")}</Typography>
              <Typography appearance="subdued" typographyType="body-sm">
                {steamSettingsAvailable
                  ? t(
                      "Recommended and enabled by default. Vortex starts with Steam's cache, keeps mod changes separate, and refreshes the private copy after Steam updates.",
                    )
                  : t("Start Steam so Vortex can read and update this game's launch settings.")}
              </Typography>
            </div>
            <Switch
              aria-label={t("Protect Steam's shader cache for this game")}
              checked={cacheRedirectEnabled === true}
              disabled={!steamSettingsAvailable || cacheRedirectEnabled === undefined}
              onChange={changeCacheRedirect}
            />
          </div>
          {cacheRedirectEnabled && data.privateShaderCache !== undefined && (
            <div className="mt-4 grid gap-3 border-t border-stroke-weak pt-4 md:grid-cols-2">
              <div>
                <Typography typographyType="body-sm">{t("Private cache")}</Typography>
                <Typography appearance="subdued" typographyType="body-sm">
                  {t(
                    "{{size}} across {{count}} files. Mods and the game may change this copy safely.",
                    {
                      size: formatBytes(data.privateShaderCache.totalBytes),
                      count: data.privateShaderCache.totalFiles,
                    },
                  )}
                </Typography>
              </div>
              <div>
                <Typography typographyType="body-sm">{t("Generated while playing")}</Typography>
                <Typography appearance="subdued" typographyType="body-sm">
                  {data.shaderCache.files === 0
                    ? t("No new shader files have been generated since the Steam copy was created.")
                    : t(
                        "{{size}} across {{count}} files were created or updated by this game and its mods.",
                        {
                          size: formatBytes(data.shaderCache.bytes),
                          count: data.shaderCache.files,
                        },
                      )}
                </Typography>
              </div>
              <div>
                <Typography typographyType="body-sm">{t("Copied from Steam")}</Typography>
                <Typography appearance="subdued" className="break-all" typographyType="body-sm">
                  {data.privateShaderCache.sourcePath ??
                    t(
                      "A Steam cache has not been copied yet. It will be created when the game starts.",
                    )}
                </Typography>
              </div>
              <div>
                <Typography typographyType="body-sm">{t("Stored by Vortex")}</Typography>
                <Typography appearance="subdued" className="break-all" typographyType="body-sm">
                  {data.privateShaderCache.privatePath}
                </Typography>
              </div>
              <Typography appearance="subdued" className="md:col-span-2" typographyType="body-sm">
                {t(
                  "Reset cache removes this private copy and immediately replaces it with a clean copy of Steam's current cache. It does not remove mods, game files, or Steam downloads.",
                )}
              </Typography>
            </div>
          )}
        </section>
        <section className="flex items-center justify-between gap-4 rounded-lg border border-stroke-weak bg-surface-low p-4">
          <div>
            <Typography typographyType="body-sm">
              {pageFeedback === undefined
                ? t("Was this page helpful?")
                : t("Thanks for your feedback")}
            </Typography>
            <Typography appearance="subdued" typographyType="body-sm">
              {t("Your feedback helps make Linux game and mod setup easier to understand.")}
            </Typography>
          </div>
          <div className="flex shrink-0 items-center gap-x-2">
            <Button
              appearance="subdued"
              brand="neutral"
              disabled={pageFeedback !== undefined}
              leftIconPath={mdiThumbUpOutline}
              size="sm"
              title={t("Helpful")}
              onClick={() => givePageFeedback(true)}
            />
            <Button
              appearance="subdued"
              brand="neutral"
              disabled={pageFeedback !== undefined}
              leftIconPath={mdiThumbDownOutline}
              size="sm"
              title={t("Not helpful")}
              onClick={() => givePageFeedback(false)}
            />
          </div>
        </section>
      </PageScroll>
    </Page>
  );
};
