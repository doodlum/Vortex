import { createAction } from "redux-act";

import type { IPanelWorkspace } from "@/util/panelLayout";

export const setPanelWorkspace = createAction(
  "SET_PANEL_WORKSPACE",
  (scope: string, layoutKey: string, workspace: IPanelWorkspace) => ({
    scope,
    layoutKey,
    workspace,
  }),
);
