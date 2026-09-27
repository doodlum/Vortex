import { mdiAlertCircleOutline, mdiSync } from "@mdi/js";
import React from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "@/ui/components/icon/Icon";
import { joinClasses } from "@/ui/utils/joinClasses";

import { PlayButton } from "../PlayButton";
import { deployAction, deployCopy } from "./deployCopy";
import { DeployTooltip } from "./DeployTooltip";
import type { IDeployControlProps } from "./types";

/**
 * NMA's indeterminate ProgressBar, with the running job's status over the track.
 * Focusable, so its tooltip stays in reach from the keyboard.
 */
const ApplyProgress = ({
  collapsed,
  label,
  text,
}: {
  collapsed: boolean;
  label: string;
  text: string;
}) => (
  <div
    aria-busy
    aria-label={label}
    aria-valuetext={text}
    className="nxm-deploy-apply-progress"
    data-deploy-state="deploying"
    data-testid="deploy-mods"
    role="progressbar"
    tabIndex={0}
  >
    <span className="nxm-deploy-apply-progress-track">
      <span className="nxm-deploy-apply-progress-indicator" />
    </span>

    {!collapsed && <span className="nxm-deploy-apply-progress-text">{text}</span>}
  </div>
);

/**
 * NMA's "Processing changes..." row, for a deployment that waits on another operation:
 * its 270-degree Spinner and the text beside it. Collapsed, the spinner alone.
 */
const ApplyProcessing = ({
  collapsed,
  label,
  text,
}: {
  collapsed: boolean;
  label: string;
  text: string;
}) => (
  <div
    aria-busy
    aria-label={label}
    className="nxm-deploy-apply-processing"
    data-deploy-state="deploying"
    data-testid="deploy-mods"
    role="status"
    tabIndex={0}
  >
    <span className="nxm-deploy-apply-spinner" />

    {!collapsed && <span className="nxm-deploy-apply-processing-text">{text}</span>}
  </div>
);

/**
 * 1, Apply panel: the Nexus Mods app's left-menu Apply control, as faithfully as Vortex
 * can draw it. Its card; its Apply button (here Deploy) only while there are changes to
 * apply; its indeterminate progress bar, showing what the job is doing, in the button's
 * place while it applies; and the Launch button (here Play) under it, disabled while it
 * applies. The colours, sizes, type and motion are NMA's own - see deploy-apply.css.
 */
export const DeployApply = ({ deploy, play }: IDeployControlProps) => {
  const { t } = useTranslation();
  const copy = deployCopy(t, deploy);
  const { status } = deploy;
  const collapsed = play.isCollapsed;

  return (
    <div
      className={joinClasses(["nxm-deploy-apply"], { "nxm-deploy-apply-collapsed": collapsed })}
      data-deploy-state={status === "idle" ? "idle" : undefined}
      data-testid={status === "idle" ? "deploy-mods" : undefined}
    >
      {(status === "needed" || status === "failed") && (
        <DeployTooltip copy={copy}>
          <button
            aria-label={collapsed ? copy.title : undefined}
            className="nxm-deploy-apply-button"
            data-deploy-state={status}
            data-testid="deploy-mods"
            type="button"
            onClick={deployAction(deploy)}
          >
            <Icon
              className="nxm-deploy-apply-icon"
              path={status === "failed" ? mdiAlertCircleOutline : mdiSync}
              size="none"
            />

            {!collapsed && <span className="nxm-deploy-apply-title">{copy.label}</span>}
          </button>
        </DeployTooltip>
      )}

      {deploy.isWaiting && (
        <DeployTooltip copy={copy}>
          <ApplyProcessing
            collapsed={collapsed}
            label={copy.title}
            text={deploy.progressText ?? copy.label}
          />
        </DeployTooltip>
      )}

      {deploy.isDeploying && (
        <DeployTooltip copy={copy}>
          <ApplyProgress
            collapsed={collapsed}
            label={copy.title}
            text={deploy.progressText ?? copy.label}
          />
        </DeployTooltip>
      )}

      <PlayButton
        {...play}
        className="nxm-deploy-apply-play"
        disabled={play.disabled || status === "deploying"}
      />
    </div>
  );
};
