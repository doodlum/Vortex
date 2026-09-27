import { mdiLock } from "@mdi/js";
import React from "react";

import type { IDeployMods } from "@/extensions/mod_management/hooks/useDeployMods.hook";
import type { TFunction } from "@/util/i18n";

import { getIconPath } from "../../iconMap";
import type { IPlayButtonProps, IPlayGate } from "../PlayButton";
import { deployCopy, progressLabel } from "./deployCopy";
import { DeployTooltipContent } from "./DeployTooltip";

/** Design comparison: the ways Play is held back while a deployment is pending. */
export const PLAY_GATES = [
  { id: 1, name: "Disabled" },
  { id: 2, name: "Locked by the row" },
  { id: 3, name: "Apply first" },
] as const;

/**
 * Whether a deployment is pending: needed, running or waiting to, or failed with changes
 * still undeployed. A failure with nothing pending - a running tool refused one - isn't.
 */
export const isDeployPending = (deploy: IDeployMods): boolean =>
  deploy.status === "needed" ||
  deploy.status === "deploying" ||
  (deploy.status === "failed" && deploy.needToDeploy);

/**
 * How Play is held back while a deployment is pending, or `undefined` when it isn't and
 * Play plays. None of them launches the game while one is pending: Disabled and Locked
 * never run Play's action then, and Deploy first runs it only after a deployment that
 * completed without a failure, when nothing is pending any more - so Vortex's own
 * pre-launch "Pending deployment" prompt can't come up from Play in any of them.
 */
export const playGate = (
  t: TFunction,
  gateId: number,
  deploy: IDeployMods,
  play: IPlayButtonProps,
  focusRow: () => void,
): IPlayGate | undefined => {
  if (!isDeployPending(deploy)) {
    return undefined;
  }

  const deploying = deploy.status === "deploying";
  // what Play says while held back: the running deployment, or that it has to come first
  const blocked = deploying ? progressLabel(t, deploy) : t("Apply changes first");
  // the row's one short sentence, without its More: Play's tooltip isn't one to click into
  const copy = { ...deployCopy(t, deploy), title: blocked, label: blocked, more: undefined };
  const reason = <DeployTooltipContent copy={copy} padded={false} />;
  const ariaLabel = `${t("Play")}: ${blocked}`;

  switch (gateId) {
    // Locked by the row: Play wears a lock and the pending state's name, and a click
    // sends focus to the row, which says why and is the way on.
    case 2:
      return {
        reason,
        ariaLabel,
        label: blocked,
        iconPath: mdiLock,
        busy: deploying || undefined,
        onClick: focusRow,
      };
    // Deploy first: Play deploys, and launches when that completes without a failure.
    case 3:
      return deploying
        ? { reason, ariaLabel, inert: true, busy: true, label: blocked }
        : {
            reason,
            ariaLabel: play.disabled ? ariaLabel : t("Apply & play"),
            label: t("Apply & play"),
            iconPath: getIconPath("deploy"),
            onClick: () => deploy.deploy(play.onClick),
          };
    // Disabled: Play is unavailable, and says why; the row is the only way on.
    default:
      return { reason, ariaLabel, inert: true, busy: deploying || undefined };
  }
};
