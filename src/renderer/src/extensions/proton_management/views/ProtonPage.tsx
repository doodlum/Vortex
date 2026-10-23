import * as os from "os";
import * as path from "path";

import { unknownToError } from "@vortex/shared";
import { ProcessCanceled } from "@vortex/shared/errors";
import React, { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDispatch, useSelector } from "react-redux";

import type { IExtensionApi } from "@/types/IExtensionContext";
import type { IState } from "@/types/IState";
import { Alert } from "@/ui/components/alert/Alert";
import { Button } from "@/ui/components/button/Button";
import { Description } from "@/ui/components/form/field/Description";
import { ErrorMessage } from "@/ui/components/form/field/ErrorMessage";
import { Field } from "@/ui/components/form/field/Field";
import { Label } from "@/ui/components/form/field/Label";
import { Switch } from "@/ui/components/form/switch/Switch";
import { NoResults } from "@/ui/components/no_results/NoResults";
import { Picker } from "@/ui/components/picker/Picker";
import { Pill } from "@/ui/components/pill/Pill";
import { Toolbar } from "@/ui/components/toolbar/Toolbar";
import type { IToolbarAction } from "@/ui/components/toolbar/ToolbarGroup";
import { ToolbarGroup } from "@/ui/components/toolbar/ToolbarGroup";
import { Tooltip } from "@/ui/components/tooltip/Tooltip";
import { TooltipDelayGroup } from "@/ui/components/tooltip/TooltipDelayGroup";
import { Typography } from "@/ui/components/typography/Typography";
import {
  inspectPrefix,
  listInstalledProton,
  protonConfigName,
  RECOMMENDED_PROTON,
} from "@/util/linux/proton";
import { findLinuxSteamPath } from "@/util/linux/steamPaths";
import { useSteamGamesRevision } from "@/util/linux/steamRevision";
import Steam from "@/util/Steam";
import { useRelativeTime } from "@/util/useRelativeTime";
import { Page } from "@/views/components/Page/Page";
import { PageContent } from "@/views/components/Page/PageContent";
import { PageHeader } from "@/views/components/Page/PageHeader";
import { PageScroll } from "@/views/components/Page/PageScroll";

import { setFeature } from "../../profile_management/actions/profiles";
import { activeProfile } from "../../profile_management/selectors";
import { detectModRuntimeDependencies } from "../modRequirements";
import { currentProtonTarget, protonCoordinator } from "../orchestration";
import { activeProtonGame } from "../selection";
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
  configureShaderCache,
  checkShaderCacheWrapper,
  ensureShaderCacheWrapper,
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
  installed: string[];
  shaderCache: IModShaderCacheInfo;
  shaderRoots: string[];
  steamShaderRoots: string[];
  privateShaderCache?: IPrivateShaderCacheInfo;
}

const EMPTY_DATA: IPageData = {
  components: [],
  installed: [],
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

/** A bordered card with a heading and its actions, laid out like Health Check's issue sections. */
const Section = ({
  actions,
  children,
  description,
  testId,
  title,
}: {
  actions?: ReactNode;
  children?: ReactNode;
  description: string;
  testId?: string;
  title: string;
}) => (
  <section className="rounded-lg border border-stroke-weak p-4" data-testid={testId}>
    <div className="flex items-start justify-between gap-x-4">
      <Typography appearance="moderate" as="h3" className="font-semibold">
        {title}
      </Typography>

      {!!actions && <div className="flex shrink-0 items-center gap-x-2">{actions}</div>}
    </div>

    <Typography appearance="subdued" brand="neutral-translucent" typographyType="body-sm">
      {description}
    </Typography>

    {!!children && <div className="mt-4 space-y-2">{children}</div>}
  </section>
);

const ROW_CLASSES = "flex items-center justify-between gap-x-4 rounded-sm bg-surface-mid px-4 py-3";

/**
 * A setting inside a section, on the raised surface Health Check uses for its rows. It is a
 * `Field`, so its label and description name and describe the control, and clicking the label
 * operates it.
 */
const SettingRow = ({
  children,
  description,
  disabled,
  error,
  label,
}: {
  children: ReactNode;
  description?: string;
  disabled?: boolean;
  error?: string;
  label: string;
}) => (
  <Field className={`${ROW_CLASSES} flex-row`} disabled={disabled}>
    <div className="min-w-0 flex-1 space-y-0.5">
      <Label>{label}</Label>

      {!!description && <Description className="text-body-sm">{description}</Description>}

      {!!error && <ErrorMessage className="text-body-sm">{error}</ErrorMessage>}
    </div>

    <div className="flex shrink-0 items-center gap-x-2">{children}</div>
  </Field>
);

/** A read-only status inside a section; its pills wrap rather than squeeze the label. */
const StatusRow = ({
  children,
  description,
  label,
  testId,
}: {
  children?: ReactNode;
  description?: string;
  label: string;
  testId?: string;
}) => (
  <div className={ROW_CLASSES} data-testid={testId}>
    <div className="min-w-48 flex-1 space-y-0.5">
      <Typography appearance="moderate" typographyType="body-sm">
        {label}
      </Typography>

      {!!description && (
        <Typography appearance="subdued" brand="neutral-translucent" typographyType="body-sm">
          {description}
        </Typography>
      )}
    </div>

    {!!children && (
      <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">{children}</div>
    )}
  </div>
);

export const ProtonPage = ({ active, api }: IProtonPageProps) => {
  const { t } = useTranslation(["common"]);
  const dispatch = useDispatch();
  const profile = useSelector(activeProfile);
  const toolsRunning = useSelector((state: IState) => state.session.base.toolsRunning);
  const discovered = useSelector((state: IState) => state.settings.gameMode.discovered);
  const steamRevision = useSteamGamesRevision();
  const generation = useRef(0);
  const loadedKey = useRef<string>();
  const [missingSetup, setMissingSetup] = useState<"steam" | "game">();
  const [data, setData] = useState<IPageData>(EMPTY_DATA);
  const [loading, setLoading] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<number>();
  const [cacheRedirectEnabled, setCacheRedirectEnabled] = useState<boolean>();
  const [steamSettingsAvailable, setSteamSettingsAvailable] = useState(true);
  const [dependencyProgress, setDependencyProgress] = useState<number>();
  const [dependencyStatus, setDependencyStatus] = useState<string>();
  const [pageError, setPageError] = useState<string>();
  const [setupStatus, setSetupStatus] = useState<IProtonSetupStatus>(protonSetupStatus);
  const version = profile?.features?.["proton-version"];
  const selected = typeof version === "string" ? version : "";
  const automatic = profile?.features?.["proton-auto-dependencies"] !== false;
  const pageFeedback = profile?.features?.["proton-page-feedback"] as string | undefined;
  const targetKey = currentProtonTarget(api.getState())?.key;

  const givePageFeedback = useCallback(
    (helpful: boolean) => {
      if (profile === undefined) return;
      // The strip itself thanks the user, so no toast repeats it.
      dispatch(setFeature(profile.id, "proton-page-feedback", helpful ? "helpful" : "not-helpful"));
    },
    [dispatch, profile],
  );

  const refresh = useCallback(async () => {
    const request = ++generation.current;
    setLoading(true);
    setPageError(undefined);
    // Keep showing the last result while the same installation is re-read, so a refresh doesn't
    // briefly claim that protection is off or nothing is installed. Another target starts blank.
    const key = currentProtonTarget(api.getState())?.key;
    if (key !== loadedKey.current) {
      loadedKey.current = key;
      setData(EMPTY_DATA);
      setCacheRedirectEnabled(undefined);
    }
    try {
      const steamPath = findLinuxSteamPath();
      const entry = activeProtonGame(api.getState());
      setMissingSetup(steamPath === undefined ? "steam" : entry === undefined ? "game" : undefined);
      if (steamPath === undefined || entry === undefined || profile === undefined) {
        setData(EMPTY_DATA);
        setCacheRedirectEnabled(undefined);
        return;
      }
      const compatDataPath = entry.compatDataPath;
      const [tools, inventory, required] = await Promise.all([
        listInstalledProton(steamPath),
        compatDataPath === undefined ? undefined : inspectPrefix(compatDataPath),
        detectModRuntimeDependencies(api.getState(), profile),
      ]);
      const steamShaderRoots = [
        ...new Set([
          path.join(path.dirname(path.dirname(entry.gamePath)), "shadercache"),
          path.join(steamPath, "steamapps", "shadercache"),
        ]),
      ];
      let launchOptions = "";
      let settingsAvailable = true;
      try {
        launchOptions = await getSteamLaunchOptions(entry.appid, {
          steamPath,
          gamePath: entry.gamePath,
        });
      } catch {
        settingsAvailable = false;
      }
      const redirectEnabled =
        settingsAvailable &&
        launchOptions.includes(shaderCacheInvocation(entry.appid, SHADER_CACHE_WRAPPER));
      const shaderRoots = redirectEnabled
        ? [path.join(os.homedir(), ".cache", "vortex", "shadercache")]
        : steamShaderRoots;
      const [shaderCache, privateShaderCache] = await Promise.all([
        inspectModShaderCache(shaderRoots, entry.appid),
        redirectEnabled
          ? inspectPrivateShaderCache(
              shaderRoots[0],
              entry.appid,
              steamShaderRoots.map((root) => path.join(root, entry.appid)),
            )
          : undefined,
      ]);
      if (request !== generation.current) return;
      setSteamSettingsAvailable(settingsAvailable);
      setCacheRedirectEnabled(settingsAvailable ? redirectEnabled : undefined);
      setData({
        appId: entry.appid,
        compatDataPath,
        required,
        tools: tools.map((tool) => ({
          configName: protonConfigName(tool),
          label: tool.name,
          value: tool.path,
        })),
        components: inventory?.components ?? [],
        installed: inventory?.winetricks ?? [],
        shaderCache,
        shaderRoots,
        steamShaderRoots,
        privateShaderCache,
      });
    } catch (err) {
      if (request === generation.current) setPageError(unknownToError(err).message);
    } finally {
      if (request === generation.current) {
        setLastUpdated(Date.now());
        setLoading(false);
      }
    }
  }, [api, profile, steamRevision, discovered]);

  useEffect(() => {
    if (active !== false) void refresh();
    return () => {
      generation.current += 1;
    };
  }, [active, refresh]);

  useEffect(() => {
    setDependencyProgress(undefined);
    setDependencyStatus(undefined);
  }, [profile?.id]);

  const refreshSteam = useCallback(async () => {
    try {
      await Steam.reloadGames();
      await refresh();
    } catch (err) {
      setPageError(unknownToError(err).message);
    }
  }, [refresh]);

  useEffect(
    () =>
      subscribeProtonSetupStatus((status) => {
        setSetupStatus(status);
        if (status.phase === "ready" && status.appId === activeProtonGame(api.getState())?.appid)
          void refresh();
      }),
    [api, refresh],
  );

  const sameTarget = useCallback(
    () => targetKey !== undefined && currentProtonTarget(api.getState())?.key === targetKey,
    [api, targetKey],
  );

  const steamSettingsTarget = useCallback(() => {
    const target = currentProtonTarget(api.getState());
    if (target === undefined || !sameTarget())
      throw new ProcessCanceled("The selected Proton installation changed");
    return {
      steamPath: target.steamPath,
      gamePath: target.game.gamePath,
      assertCurrent: () => {
        if (!sameTarget()) throw new ProcessCanceled("The selected Proton installation changed");
      },
    };
  }, [api, sameTarget]);

  const retrySetup = async () => {
    if (!sameTarget()) return;
    setLoading(true);
    try {
      await protonCoordinator(api).request();
      if (sameTarget()) await refresh();
    } finally {
      if (sameTarget()) setLoading(false);
    }
  };

  const options = useMemo(
    () => [
      { label: t("{{name}} (recommended)", { name: RECOMMENDED_PROTON.label }), value: "" },
      // The recommended entry already stands for Steam's Experimental build.
      ...data.tools.filter((tool) => tool.configName !== RECOMMENDED_PROTON.configName),
      ...(selected !== "" && !data.tools.some((tool) => tool.value === selected)
        ? [
            {
              label: t("Unavailable: {{name}}", { name: path.basename(selected) }),
              value: selected,
            },
          ]
        : []),
    ],
    [data.tools, selected, t],
  );

  const changeVersion = useCallback(
    async (value: string) => {
      if (profile === undefined || data.appId === undefined) return;
      if (value === "") {
        // The coordinator points Steam at the recommended Proton, installing it first if needed.
        dispatch(setFeature(profile.id, "proton-version", ""));
        api.sendNotification({
          type: "success",
          message: `Steam and Vortex will use ${RECOMMENDED_PROTON.label}`,
          displayMS: 5000,
        });
        return;
      }
      const configName = data.tools.find((tool) => tool.value === value)?.configName;
      if (configName === undefined) {
        api.showErrorNotification(
          "Failed to change Proton version",
          new Error("Steam cannot identify this Proton installation"),
        );
        return;
      }
      if (!sameTarget()) return;
      setLoading(true);
      try {
        await setSteamCompatTool(data.appId, configName, steamSettingsTarget());
        if (!sameTarget()) return;
        dispatch(setFeature(profile.id, "proton-version", value));
        api.sendNotification({
          type: "success",
          message: `Steam and Vortex will use ${data.tools.find((tool) => tool.value === value)?.label}`,
          displayMS: 5000,
        });
        await Steam.reloadGames();
        if (sameTarget()) await refresh();
      } catch (err) {
        api.showErrorNotification("Failed to change Proton version", err);
      } finally {
        if (sameTarget()) setLoading(false);
      }
    },
    [api, data.appId, data.tools, dispatch, profile, refresh, sameTarget, steamSettingsTarget],
  );

  const missing = useMemo(
    () => data.required.filter((verb) => !data.installed.includes(verb)),
    [data.installed, data.required],
  );
  const visibleSetupStatus =
    setupStatus.appId === undefined || setupStatus.appId === data.appId ? setupStatus : undefined;
  const privateCacheMatchesSteam =
    cacheRedirectEnabled === true && data.privateShaderCache?.matchesSteam === true;
  const toolbarActions = useMemo<IToolbarAction[]>(
    () => [
      {
        label: t("common:::refresh"),
        icon: "refresh",
        isLoading: loading,
        testId: "proton-refresh",
        onClick: () => void refreshSteam(),
      },
    ],
    [loading, refreshSteam, t],
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
    if (result.action !== "Install" || targetKey === undefined || !sameTarget()) return;
    setLoading(true);
    setDependencyProgress(0);
    setDependencyStatus("Preparing dependency installation");
    try {
      await protonCoordinator(api).installManually(targetKey, (progress, message) => {
        if (!sameTarget()) return;
        setDependencyProgress(progress);
        setDependencyStatus(message);
      });
      if (!sameTarget()) return;
      setDependencyStatus("Verifying installed components");
      if (data.compatDataPath === undefined) throw new Error("The game prefix is unavailable");
      const verified = await inspectPrefix(data.compatDataPath);
      if (!sameTarget()) return;
      const unresolved = missing.filter((verb) => !verified.winetricks.includes(verb));
      if (unresolved.length > 0) {
        throw new Error(`Components were not installed correctly: ${unresolved.join(", ")}`);
      }
      await refresh();
    } catch (err) {
      if (sameTarget() && !(err instanceof ProcessCanceled)) {
        const status = protonSetupStatus();
        if (status.phase !== "error" || status.appId !== data.appId)
          api.showErrorNotification("Failed to install Windows dependencies", err, {
            id: "proton-setup-" + data.appId,
            allowReport: false,
          });
      }
    } finally {
      if (sameTarget()) {
        setDependencyProgress(undefined);
        setDependencyStatus(undefined);
        setLoading(false);
      }
    }
  }, [api, data.appId, data.compatDataPath, missing, refresh, sameTarget, targetKey]);

  const changeAutomatic = useCallback(
    (checked: boolean) => {
      if (profile !== undefined) {
        dispatch(setFeature(profile.id, "proton-auto-dependencies", checked));
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
    if (result.action !== action || !sameTarget()) return;
    if (Object.keys(api.getState().session.base.toolsRunning).length > 0) return;
    setLoading(true);
    try {
      if (isolated) {
        if (data.steamShaderRoots.length === 0 || data.shaderRoots[0] === undefined) {
          throw new Error("Shader cache paths are unavailable");
        }
        await ensureShaderCacheWrapper();
        if (!sameTarget()) return;
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
      if (sameTarget()) await refresh();
    } catch (err) {
      api.showErrorNotification("Failed to reset shader cache", err);
    } finally {
      if (sameTarget()) setLoading(false);
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
    sameTarget,
  ]);

  const changeCacheRedirect = useCallback(
    async (checked: boolean) => {
      if (data.appId === undefined) return;
      const enable = checked;
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
      if (result.action !== confirmation || !sameTarget()) return;
      setLoading(true);
      try {
        if (enable) {
          await ensureShaderCacheWrapper();
          if (!sameTarget()) return;
          await configureShaderCache(data.appId, data.steamShaderRoots);
          await checkShaderCacheWrapper(data.appId);
        }
        const current = await getSteamLaunchOptions(data.appId, steamSettingsTarget());
        if (!sameTarget()) return;
        const next = enable
          ? enableShaderCacheRedirect(current, data.appId, SHADER_CACHE_WRAPPER)
          : disableShaderCacheRedirect(current, data.appId, SHADER_CACHE_WRAPPER);
        await setSteamLaunchOptions(data.appId, next, steamSettingsTarget());
        if (!sameTarget()) return;
        if (profile !== undefined) {
          dispatch(setFeature(profile.id, "proton-shader-cache-isolation", enable));
        }
        setCacheRedirectEnabled(enable);
        api.sendNotification({
          type: "success",
          message: enable ? "Mod shader cache isolated" : "Shader-cache isolation disabled",
          displayMS: 5000,
        });
      } catch (err) {
        api.showErrorNotification("Failed to change shader-cache isolation", err);
      } finally {
        if (sameTarget()) setLoading(false);
      }
    },
    [api, data.appId, data.steamShaderRoots, dispatch, profile, sameTarget, steamSettingsTarget],
  );

  const setupInProgress =
    visibleSetupStatus !== undefined &&
    ["checking", "installing", "verifying"].includes(visibleSetupStatus.phase);
  const privateCache = cacheRedirectEnabled === true ? data.privateShaderCache : undefined;
  const selectedUnavailable =
    selected !== "" && !data.tools.some((tool) => tool.value === selected);
  const resetBlockedReason =
    data.appId === undefined
      ? undefined
      : cacheRedirectEnabled === undefined
        ? t("Start Steam so Vortex can read this game's launch settings")
        : Object.keys(toolsRunning).length > 0
          ? t("Exit the game and its tools first")
          : privateCacheMatchesSteam
            ? t("The private copy already matches Steam")
            : undefined;
  const hasAlerts =
    setupInProgress || visibleSetupStatus?.phase === "error" || pageError !== undefined;

  return (
    <Page active={active} pageId="proton" scrollable={false}>
      <PageHeader
        data-testid="proton-header"
        pictogramName="proton"
        subtitle={t("Make Windows games and their mods work correctly on Linux.")}
        title={t("Proton")}
      >
        <div className="flex shrink-0 items-center gap-x-2">
          <LastUpdated timestamp={lastUpdated} />

          <Toolbar>
            <ToolbarGroup actions={toolbarActions} />
          </Toolbar>
        </div>
      </PageHeader>

      {hasAlerts && (
        <PageContent className="shrink-0">
          {setupInProgress && (
            <Alert className="border-b-0" data-testid="proton-setup-progress" severity="info">
              {t(visibleSetupStatus.message ?? "Preparing Proton")}
              {visibleSetupStatus.progress !== undefined &&
                ` (${Math.round(visibleSetupStatus.progress)}%)`}
            </Alert>
          )}

          {visibleSetupStatus?.phase === "error" && (
            <Alert
              className="border-b-0"
              action={
                <Button
                  brand="neutral"
                  isLoading={loading}
                  leftIcon="refresh"
                  size="sm"
                  onClick={() => void retrySetup()}
                >
                  {t("Retry setup")}
                </Button>
              }
              data-testid="proton-setup-error"
              role="alert"
              severity="danger"
            >
              <strong>{t("Proton setup failed")}</strong> {visibleSetupStatus.message}
            </Alert>
          )}

          {pageError !== undefined && visibleSetupStatus?.phase !== "error" && (
            <Alert
              className="border-b-0"
              action={
                <Button
                  brand="neutral"
                  isLoading={loading}
                  leftIcon="refresh"
                  size="sm"
                  onClick={() => void refreshSteam()}
                >
                  {t("Try again")}
                </Button>
              }
              role="alert"
              severity="danger"
            >
              <strong>{t("Proton setup could not be checked")}</strong> {pageError}
            </Alert>
          )}
        </PageContent>
      )}

      <PageScroll className="space-y-4 p-6">
        {missingSetup !== undefined && !loading ? (
          <NoResults
            className="py-24"
            icon="info"
            message={
              missingSetup === "steam"
                ? t("Install Steam and sign in, then refresh this page.")
                : t(
                    "Select a Steam game that runs with Proton, and launch it from Steam once so its Windows prefix exists.",
                  )
            }
            title={missingSetup === "steam" ? t("Steam not found") : t("No Proton game selected")}
          >
            <Button
              brand="neutral"
              leftIcon="refresh"
              size="sm"
              onClick={() => void refreshSteam()}
            >
              {t("common:::refresh")}
            </Button>
          </NoResults>
        ) : (
          <>
            <Section
              description={t(
                "Choose one Proton version for both the Steam game and its mod tools, so they share the same Windows environment.",
              )}
              title={t("Windows compatibility")}
            >
              <SettingRow
                description={t(
                  "A specific version stays selected for this profile until you change it here.",
                )}
                error={
                  selectedUnavailable
                    ? t("{{path}} is no longer installed. Choose another version.", {
                        path: selected,
                      })
                    : undefined
                }
                disabled={loading || data.appId === undefined}
                label={t("Proton version")}
              >
                <Picker
                  button={{ className: "min-w-64 justify-between" }}
                  options={options}
                  value={selected}
                  onChange={(value) => void changeVersion(value)}
                />
              </SettingRow>

              <SettingRow
                description={t(
                  "Before launch, Vortex installs the extra Windows software that your active mods need.",
                )}
                label={t("Install required components automatically")}
              >
                <Switch
                  checked={automatic}
                  data-testid="proton-automatic"
                  onChange={changeAutomatic}
                />
              </SettingRow>
            </Section>

            <Section
              actions={
                missing.length > 0 && (
                  <Button
                    brand="neutral"
                    data-testid="proton-install-requirements"
                    disabled={
                      loading || data.appId === undefined || data.compatDataPath === undefined
                    }
                    isLoading={dependencyProgress !== undefined}
                    leftIcon="install_desktop"
                    size="sm"
                    onClick={satisfyDependencies}
                  >
                    {t("Install requirements ({{count}})", { count: missing.length })}
                  </Button>
                )
              }
              description={t(
                "Vortex looks for Windows runtime hints, such as Visual C++ and DirectX, in your installed mods and installs them with Protontricks. A hint is not proof that a mod needs a component.",
              )}
              testId="proton-requirements"
              title={t("Mod requirements")}
            >
              {dependencyProgress !== undefined && (
                <StatusRow
                  label={`${t(dependencyStatus ?? "Working")} (${Math.round(dependencyProgress)}%)`}
                  testId="proton-dependency-progress"
                />
              )}

              {missing.length > 0 && (
                <StatusRow label={t("Still needed by your mods")}>
                  {missing.map((item) => (
                    <Pill brand="warning" icon="warning" key={item}>
                      {item}
                    </Pill>
                  ))}
                </StatusRow>
              )}

              <StatusRow
                description={
                  data.appId !== undefined && data.installed.length === 0
                    ? t("Winetricks has no additional Windows components recorded for this game.")
                    : undefined
                }
                label={
                  data.appId === undefined
                    ? t("Checking installed components")
                    : data.required.length === 0
                      ? t("No requirements detected")
                      : missing.length === 0
                        ? t("All requirements installed")
                        : t("Installed components")
                }
              >
                {data.installed.length > 0 &&
                  data.installed.map((item) => (
                    <Pill brand="success" icon="check_circle" key={item}>
                      {item}
                    </Pill>
                  ))}
              </StatusRow>
            </Section>

            <Section
              actions={
                <Tooltip
                  content={resetBlockedReason ?? ""}
                  disabled={resetBlockedReason === undefined}
                  placement="bottom"
                >
                  {/* A disabled button takes no focus, so its wrapper carries the reason to keyboard users. */}
                  <span
                    aria-label={resetBlockedReason}
                    className="inline-flex rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info-subdued"
                    role={resetBlockedReason === undefined ? undefined : "group"}
                    tabIndex={resetBlockedReason === undefined ? undefined : 0}
                  >
                    <Button
                      appearance="subdued"
                      brand="neutral"
                      data-testid="proton-reset-cache"
                      disabled={data.appId === undefined || resetBlockedReason !== undefined}
                      leftIcon="delete_sweep"
                      size="sm"
                      onClick={clearShaderCache}
                    >
                      {t("Reset cache")}
                    </Button>
                  </span>
                </Tooltip>
              }
              description={
                cacheRedirectEnabled === undefined
                  ? t("Vortex needs Steam's launch settings to tell where this game's cache is.")
                  : cacheRedirectEnabled
                    ? t("Steam's cache is protected. Mod changes stay in a private copy.")
                    : t("Protection is off. Mod changes may reach Steam's cache.")
              }
              title={t("Mod shader cache")}
            >
              <SettingRow
                description={
                  steamSettingsAvailable
                    ? t("Recommended. Refreshes automatically when Steam's cache changes.")
                    : t("Start Steam so Vortex can read and update this game's launch settings.")
                }
                disabled={!steamSettingsAvailable || cacheRedirectEnabled === undefined}
                label={t("Protect Steam's shader cache")}
              >
                <Switch
                  checked={cacheRedirectEnabled === true}
                  data-testid="proton-cache-isolation"
                  onChange={changeCacheRedirect}
                />
              </SettingRow>

              {privateCache !== undefined && (
                <StatusRow
                  description={
                    privateCacheMatchesSteam
                      ? undefined
                      : privateCache.missingFiles > 0
                        ? t("{{count}} Steam files are missing from the copy.", {
                            count: privateCache.missingFiles,
                          })
                        : t("Reset removes only private changes.")
                  }
                  label={t("Private copy")}
                  testId="proton-cache-usage"
                >
                  {privateCacheMatchesSteam && (
                    <Pill brand="success" data-testid="proton-cache-matches" icon="check_circle">
                      {t("Matches Steam")}
                    </Pill>
                  )}

                  <Pill icon="content_copy">
                    {t("From Steam: {{size}} · {{count}} files", {
                      size: formatBytes(privateCache.copiedBytes),
                      count: privateCache.copiedFiles,
                    })}
                  </Pill>

                  <Pill brand={privateCache.changedFiles > 0 ? "info" : "neutral"} icon="edit">
                    {t("Added or changed: {{size}} · {{count}} files", {
                      size: formatBytes(privateCache.changedBytes),
                      count: privateCache.changedFiles,
                    })}
                  </Pill>
                </StatusRow>
              )}
            </Section>

            <div className="flex items-center justify-between gap-x-4 rounded-lg border border-stroke-weak px-4 py-3">
              <Typography appearance="moderate" typographyType="body-sm">
                {pageFeedback === undefined
                  ? t("Was this page helpful?")
                  : t("common:::thanks_for_your_feedback")}
              </Typography>

              <div className="flex shrink-0 items-center gap-x-2">
                <TooltipDelayGroup>
                  <Tooltip content={t("common:::helpful")} placement="bottom">
                    <Button
                      appearance="subdued"
                      aria-label={t("common:::helpful")}
                      brand="neutral"
                      disabled={pageFeedback !== undefined}
                      leftIcon="thumb_up"
                      size="sm"
                      onClick={() => givePageFeedback(true)}
                    />
                  </Tooltip>

                  <Tooltip content={t("common:::not_helpful")} placement="bottom">
                    <Button
                      appearance="subdued"
                      aria-label={t("common:::not_helpful")}
                      brand="neutral"
                      disabled={pageFeedback !== undefined}
                      leftIcon="thumb_down"
                      size="sm"
                      onClick={() => givePageFeedback(false)}
                    />
                  </Tooltip>
                </TooltipDelayGroup>
              </div>
            </div>
          </>
        )}
      </PageScroll>
    </Page>
  );
};
