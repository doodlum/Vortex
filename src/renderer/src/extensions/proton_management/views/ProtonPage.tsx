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
import {
  findLatestStableProtonName,
  getCompatDataPath,
  inspectPrefix,
  listInstalledProton,
  protonConfigName,
} from "@/util/linux/proton";
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
  protonSetupStatus,
  subscribeProtonSetupStatus,
  type IProtonSetupStatus,
} from "../setupStatus";
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
  setSteamCompatTool,
  shaderCacheInvocation,
} from "../steamShaderSettings";

interface IProtonPageProps {
  api: IExtensionApi;
  active?: boolean;
}

interface IPageData {
  appId?: string;
  compatDataPath?: string;
  required: string[];
  tools: Array<{ configName?: string; label: string; value: string }>;
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
  const [pageError, setPageError] = useState<string>();
  const [setupStatus, setSetupStatus] = useState<IProtonSetupStatus>(protonSetupStatus);
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
    setPageError(undefined);
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
      const compatDataPath =
        entry === undefined
          ? undefined
          : (entry.compatDataPath ??
            getCompatDataPath(path.dirname(path.dirname(entry.gamePath)), entry.appid));
      const inventory =
        compatDataPath === undefined ? undefined : await inspectPrefix(compatDataPath);
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
        compatDataPath,
        required,
        tools: tools.map((tool) => ({
          configName: protonConfigName(tool),
          label: tool.name,
          value: tool.path,
        })),
        components: inventory?.components ?? [],
        shaderCache,
        shaderRoots,
        steamShaderRoots,
        privateShaderCache,
      });
    } catch (err: any) {
      setPageError(err?.message ?? String(err));
    } finally {
      setLastUpdated(Date.now());
      setLoading(false);
    }
  }, [api, profile]);

  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);

  useEffect(() => subscribeProtonSetupStatus(setSetupStatus), []);

  const options = useMemo(
    () => [{ label: t("Latest stable"), value: "" }, ...data.tools],
    [data.tools, t],
  );

  const changeVersion = useCallback(
    async (value: string) => {
      if (profile === undefined || data.appId === undefined) return;
      const steamPath = findLinuxSteamPath();
      if (steamPath === undefined) return;
      const configName =
        value === ""
          ? await findLatestStableProtonName(steamPath)
          : data.tools.find((tool) => tool.value === value)?.configName;
      if (configName === undefined) {
        api.showErrorNotification(
          "Failed to change Proton version",
          new Error("Steam cannot identify this Proton installation"),
        );
        return;
      }
      setLoading(true);
      try {
        await setSteamCompatTool(data.appId, configName);
        dispatch(setFeature(profile.id, "proton-version", value));
        api.sendNotification({
          type: "success",
          message: `Steam and Vortex will use ${
            value === ""
              ? "the latest stable Proton"
              : data.tools.find((tool) => tool.value === value)?.label
          }`,
          displayMS: 5000,
        });
        await refresh();
      } catch (err) {
        api.showErrorNotification("Failed to change Proton version", err);
      } finally {
        setLoading(false);
      }
    },
    [api, data.appId, data.tools, dispatch, profile, refresh],
  );

  const missing = useMemo(
    () => data.required.filter((verb) => !data.components.includes(verb)),
    [data.components, data.required],
  );
  const visibleSetupStatus =
    setupStatus.appId === undefined || setupStatus.appId === data.appId ? setupStatus : undefined;
  const privateCacheMatchesSteam =
    cacheRedirectEnabled === true && data.privateShaderCache?.matchesSteam === true;
  const cacheChangedPercent = useMemo(() => {
    const cache = data.privateShaderCache;
    if (cache === undefined) return 0;
    const total = cache.copiedBytes + cache.changedBytes;
    if (total > 0) return Math.round((cache.changedBytes / total) * 100);
    const files = cache.copiedFiles + cache.changedFiles;
    return files === 0 ? 0 : Math.round((cache.changedFiles / files) * 100);
  }, [data.privateShaderCache]);

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
      if (data.compatDataPath === undefined) throw new Error("The game prefix is unavailable");
      const verified = await inspectPrefix(data.compatDataPath);
      const unresolved = missing.filter((verb) => !verified.components.includes(verb));
      if (unresolved.length > 0) {
        throw new Error(`Components were not installed correctly: ${unresolved.join(", ")}`);
      }
      await refresh();
      api.sendNotification({
        type: "success",
        message: "Mod requirements installed and verified",
        displayMS: 5000,
      });
    } catch (err) {
      api.showErrorNotification("Failed to install Windows dependencies", err);
    } finally {
      setDependencyProgress(undefined);
      setDependencyStatus(undefined);
      setLoading(false);
    }
  }, [api, data.appId, data.compatDataPath, missing, refresh]);

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
        {visibleSetupStatus !== undefined &&
          ["checking", "installing", "verifying"].includes(visibleSetupStatus.phase) && (
            <div className="rounded-lg border border-stroke-weak bg-surface-low p-4">
              <Typography typographyType="body-sm">
                {t(visibleSetupStatus.message ?? "Preparing Proton")}
              </Typography>
              <ProgressBar max={100} min={0} now={visibleSetupStatus.progress ?? 0} />
            </div>
          )}
        {visibleSetupStatus?.phase === "error" && (
          <div className="rounded-md bg-danger-subdued p-4">
            <Typography typographyType="body-sm">{t("Automatic setup failed")}</Typography>
            <Typography appearance="subdued" className="mt-1" typographyType="body-sm">
              {visibleSetupStatus.message}
            </Typography>
          </div>
        )}
        {pageError !== undefined && (
          <div className="rounded-md bg-danger-subdued p-4">
            <Typography typographyType="body-sm">
              {t("Proton setup could not be checked")}
            </Typography>
            <Typography appearance="subdued" className="mt-1" typographyType="body-sm">
              {pageError}
            </Typography>
            <Button className="mt-3" leftIconPath={mdiRefresh} size="sm" onClick={refresh}>
              {t("Try again")}
            </Button>
          </div>
        )}
        <section className="rounded-lg border border-stroke-weak bg-surface-low p-6">
          <Typography as="h3" typographyType="heading-sm">
            {t("Windows compatibility")}
          </Typography>
          <Typography appearance="subdued" className="mt-2">
            {t(
              "Choose one Proton version for both the Steam game and its mod tools. Vortex keeps them together so they use the same Windows environment.",
            )}
          </Typography>
          <Picker
            button={{ className: "min-w-64 justify-between" }}
            className="mt-4 w-fit"
            options={options}
            value={selected}
            onChange={(value) => void changeVersion(value)}
          />
          <Typography appearance="subdued" className="mt-2" typographyType="body-sm">
            {t("A specific version remains selected for this profile until you change it here.")}
          </Typography>
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
                {cacheRedirectEnabled
                  ? t("Steam's cache is protected. Mod changes stay in a private copy.")
                  : t("Protection is off. Mod changes may reach Steam's cache.")}
              </Typography>
            </div>
            <Button
              disabled={
                data.appId === undefined ||
                Object.keys(toolsRunning).length > 0 ||
                privateCacheMatchesSteam
              }
              leftIconPath={mdiDeleteSweep}
              onClick={clearShaderCache}
            >
              {privateCacheMatchesSteam ? t("Already matches Steam") : t("Reset cache")}
            </Button>
          </div>
          <div className="mt-4 flex items-center justify-between gap-4 border-t border-stroke-weak pt-4">
            <div>
              <Typography typographyType="body-sm">{t("Protect Steam's shader cache")}</Typography>
              <Typography appearance="subdued" typographyType="body-sm">
                {steamSettingsAvailable
                  ? t("Recommended. Refreshes automatically when Steam's cache changes.")
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
            <div className="mt-4 border-t border-stroke-weak pt-4">
              <div className="rounded-md bg-surface-mid p-4">
                <div className="mb-3 flex items-end justify-between gap-4">
                  <div>
                    <Typography appearance="subdued" typographyType="body-sm">
                      {t("Private cache")}
                    </Typography>
                    <Typography as="div" typographyType="heading-sm">
                      {formatBytes(
                        data.privateShaderCache.copiedBytes + data.privateShaderCache.changedBytes,
                      )}
                    </Typography>
                  </div>
                  <Typography appearance="subdued" typographyType="body-sm">
                    {data.privateShaderCache.copiedFiles + data.privateShaderCache.changedFiles}{" "}
                    {t("files")}
                  </Typography>
                </div>
                <div className="flex h-2 overflow-hidden rounded-sm bg-surface-high">
                  <div
                    className="bg-neutral-subdued"
                    style={{ width: `${100 - cacheChangedPercent}%` }}
                  />
                  <div className="bg-white" style={{ width: `${cacheChangedPercent}%` }} />
                </div>
                <div className="mt-2 flex justify-between gap-4">
                  <Typography appearance="subdued" typographyType="body-sm">
                    {t("Steam {{percent}}%", { percent: 100 - cacheChangedPercent })}
                  </Typography>
                  <Typography appearance="subdued" typographyType="body-sm">
                    {t("Changed {{percent}}%", { percent: cacheChangedPercent })}
                  </Typography>
                </div>
              </div>
              {!privateCacheMatchesSteam && (
                <div className="mt-3 flex items-center justify-between gap-4">
                  <Typography appearance="subdued" typographyType="body-sm">
                    {data.privateShaderCache.missingFiles > 0
                      ? t("{{count}} Steam files are missing from the copy.", {
                          count: data.privateShaderCache.missingFiles,
                        })
                      : t("Reset removes only private changes.")}
                  </Typography>
                </div>
              )}
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
