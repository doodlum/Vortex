import React, { type ComponentType } from "react";
import { useSelector } from "react-redux";

import { useDeployMods } from "@/extensions/mod_management/hooks/useDeployMods.hook";
import {
  DEPLOY_DESIGN_IDS,
  resolveDeployDesign,
} from "@/extensions/settings_interface/deployDesigns";
import type { IState } from "@/types/IState";

import { type IPlayButtonProps, PlayButton } from "../PlayButton";
import { StatusRowChip } from "./StatusRowChip";
import { StatusRowDot } from "./StatusRowDot";
import { StatusRowLine } from "./StatusRowLine";
import { StatusRowTint } from "./StatusRowTint";
import { StatusRowTwoLine } from "./StatusRowTwoLine";
import type { IDeployControlProps } from "./types";

/**
 * Design comparison: the menu's Deploy status row in five variations, picked in Settings >
 * Interface. To be reduced to the chosen one before this goes upstream.
 */
export interface IDeployDesign {
  id: (typeof DEPLOY_DESIGN_IDS)[number];
  name: string;
  Component: ComponentType<IDeployControlProps>;
}

export const DEPLOY_DESIGNS: IDeployDesign[] = [
  { id: 6, name: "Dot", Component: StatusRowDot },
  { id: 7, name: "Two lines", Component: StatusRowTwoLine },
  { id: 8, name: "Progress line", Component: StatusRowLine },
  { id: 9, name: "Chip", Component: StatusRowChip },
  { id: 10, name: "Tint", Component: StatusRowTint },
];

/** The variation shown until the user picks another. */
export const DEFAULT_DEPLOY_DESIGN = DEPLOY_DESIGN_IDS[0];

/** The variation a stored choice names, or the default for a design that was removed. */
export const designSelector = (state: IState): number =>
  resolveDeployDesign(state.settings.interface.deployButtonStyle);

/** Deploy's status row, in whichever variation the setting picks, and Play under it. */
export const DeployControl = ({ play }: { play: IPlayButtonProps }) => {
  const deploy = useDeployMods();
  const designId = useSelector(designSelector);
  const design = DEPLOY_DESIGNS.find((candidate) => candidate.id === designId) ?? DEPLOY_DESIGNS[0];
  const { Component } = design;

  return (
    <div className="flex w-full flex-col gap-y-2" data-deploy-design={design.id}>
      <Component deploy={deploy} play={play} />

      <PlayButton {...play} />
    </div>
  );
};
