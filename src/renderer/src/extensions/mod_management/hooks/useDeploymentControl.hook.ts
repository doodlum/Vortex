import { useEffect, useState } from "react";
import { useSelector } from "react-redux";
import shortid from "shortid";

import { useMainContext } from "@/contexts";
import type { IState } from "@/types/IState";
import { activeProfile } from "@/util/selectors";

import { clearDeploymentControl, setDeploymentControl } from "../actions/session";

const selectModernLayout = (state: IState) => state.settings.window.useModernLayout ?? true;

/** Registers only the mounted game's control; an old unmount cannot clear its replacement. */
export function useDeploymentControl(gameId: string | undefined, visible: boolean): void {
  const { api } = useMainContext();
  const profile = useSelector(activeProfile);
  const modern = useSelector(selectModernLayout);
  const [owner] = useState(() => shortid());
  const profileId = profile?.id;
  const profileGameId = profile?.gameId;

  useEffect(() => {
    if (
      !visible ||
      !modern ||
      gameId === undefined ||
      profileId === undefined ||
      profileGameId !== gameId
    ) {
      return;
    }
    api.store.dispatch(setDeploymentControl({ gameId, profileId, owner }));
    return () => {
      api.store.dispatch(clearDeploymentControl(owner));
    };
  }, [api, gameId, modern, owner, profileGameId, profileId, visible]);
}
