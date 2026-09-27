import type { IDeployMods } from "@/extensions/mod_management/hooks/useDeployMods.hook";

import type { IPlayButtonProps } from "../PlayButton";

/** What each design of the Deploy control is given: deployment's state, and Play's. */
export interface IDeployControlProps {
  deploy: IDeployMods;
  play: IPlayButtonProps;
}
