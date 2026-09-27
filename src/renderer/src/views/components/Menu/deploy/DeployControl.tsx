import React, { type ComponentType } from "react";
import { useSelector } from "react-redux";

import { useDeployMods } from "@/extensions/mod_management/hooks/useDeployMods.hook";
import type { IState } from "@/types/IState";

import type { IPlayButtonProps } from "../PlayButton";
import { DeployApply } from "./DeployApply";
import { DeployMerged } from "./DeployMerged";
import { DeployRocket } from "./DeployRocket";
import { DeploySplit } from "./DeploySplit";
import { DeployStatusRow } from "./DeployStatusRow";
import type { IDeployControlProps } from "./types";

/**
 * Design comparison: the menu's Deploy control in five designs, picked in Settings >
 * Interface. To be reduced to the chosen one before this goes upstream.
 */
export interface IDeployDesign {
  id: number;
  name: string;
  Component: ComponentType<IDeployControlProps>;
}

export const DEPLOY_DESIGNS: IDeployDesign[] = [
  { id: 1, name: "Apply panel (NMA)", Component: DeployApply },
  { id: 2, name: "Split with Play", Component: DeploySplit },
  { id: 3, name: "Status row", Component: DeployStatusRow },
  { id: 4, name: "Rocket button", Component: DeployRocket },
  { id: 5, name: "Merged into Play", Component: DeployMerged },
];

/** The design shown until the user picks another. */
export const DEFAULT_DEPLOY_DESIGN = 1;

const designSelector = (state: IState): number =>
  state.settings.interface.deployButtonStyle ?? DEFAULT_DEPLOY_DESIGN;

/** Deploy, and Play with it, in whichever design the setting picks. */
export const DeployControl = ({ play }: { play: IPlayButtonProps }) => {
  const deploy = useDeployMods();
  const designId = useSelector(designSelector);
  const design =
    DEPLOY_DESIGNS.find((candidate) => candidate.id === designId) ??
    DEPLOY_DESIGNS.find((candidate) => candidate.id === DEFAULT_DEPLOY_DESIGN)!;
  const { Component } = design;

  return (
    <div className="w-full" data-deploy-design={design.id}>
      <Component deploy={deploy} play={play} />
    </div>
  );
};
