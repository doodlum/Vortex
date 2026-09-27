import React, { type ComponentType, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSelector } from "react-redux";

import { useDeployMods } from "@/extensions/mod_management/hooks/useDeployMods.hook";
import {
  DEPLOY_DESIGN_IDS,
  resolveDeployDesign,
  resolvePlayGate,
} from "@/extensions/settings_interface/deployDesigns";
import type { IState } from "@/types/IState";
import { joinClasses } from "@/ui/utils/joinClasses";

import { type IPlayButtonProps, PlayButton } from "../PlayButton";
import { playGate } from "./playGate";
import { StatusRowDot } from "./StatusRowDot";
import { StatusRowSolid } from "./StatusRowSolid";
import { StatusRowTint } from "./StatusRowTint";
import { StatusRowTwoLine } from "./StatusRowTwoLine";
import type { IDeployControlProps } from "./types";

/**
 * Design comparison: the menu's Deploy status row in four variations, picked in
 * Settings > Interface. To be reduced to the chosen one before this goes upstream.
 */
export interface IDeployDesign {
  id: (typeof DEPLOY_DESIGN_IDS)[number];
  name: string;
  Component: ComponentType<IDeployControlProps>;
}

export const DEPLOY_DESIGNS: IDeployDesign[] = [
  { id: 6, name: "Dot", Component: StatusRowDot },
  { id: 7, name: "Two lines", Component: StatusRowTwoLine },
  { id: 10, name: "Tint", Component: StatusRowTint },
  { id: 11, name: "Solid", Component: StatusRowSolid },
];

/** The variation shown until the user picks another. */
export const DEFAULT_DEPLOY_DESIGN = DEPLOY_DESIGN_IDS[0];

/** The variation a stored choice names, or the default for a design that was removed. */
export const designSelector = (state: IState): number =>
  resolveDeployDesign(state.settings.interface.deployButtonStyle);

/** How Play is held back while a deployment is pending. */
export const playGateSelector = (state: IState): number =>
  resolvePlayGate(state.settings.interface.playWhilePending);

/** How long the row draws attention after a locked Play sends the user to it. */
const ATTENTION_MS = 700;

/** Deploy's status row, in whichever variation the setting picks, and Play under it. */
export const DeployControl = ({ play }: { play: IPlayButtonProps }) => {
  const { t } = useTranslation();
  const deploy = useDeployMods();
  const designId = useSelector(designSelector);
  const gateId = useSelector(playGateSelector);
  const rowRef = useRef<HTMLDivElement>(null);
  const [attention, setAttention] = useState(false);
  const design = DEPLOY_DESIGNS.find((candidate) => candidate.id === designId) ?? DEPLOY_DESIGNS[0];
  const { Component } = design;

  // A timer rather than animationend: under reduced motion the animation never runs.
  useEffect(() => {
    if (!attention) {
      return;
    }
    const timer = setTimeout(() => setAttention(false), ATTENTION_MS);
    return () => clearTimeout(timer);
  }, [attention]);

  const focusRow = useCallback(() => {
    rowRef.current?.querySelector<HTMLElement>('[data-testid="deploy-mods"]')?.focus();
    setAttention(true);
  }, []);

  const gate = playGate(t, gateId, deploy, play, focusRow);

  return (
    <div
      className="flex w-full flex-col gap-y-2"
      data-deploy-design={design.id}
      data-play-gate-style={gateId}
    >
      <div
        className={joinClasses(["rounded-lg"], { "animate-deploy-attention": attention })}
        data-attention={attention || undefined}
        ref={rowRef}
      >
        <Component deploy={deploy} play={play} />
      </div>

      <PlayButton {...play} gate={gate} />
    </div>
  );
};
