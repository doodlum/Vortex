import * as actions from "../actions/panels";
import { isPanelWorkspace, type IPanelSettings } from "../util/panelLayout";
import { actionsToReducerSpec } from "./builder";

const defaults: IPanelSettings = { layouts: {} };
export const panelsReducer = actionsToReducerSpec(
  defaults,
  actions,
  {
    setPanelWorkspace: (state, { scope, layoutKey, workspace }) => {
      if (!scope || !layoutKey || !isPanelWorkspace(workspace)) return state;
      const next = { ...state };
      delete (next as IPanelSettings & { showTabs?: boolean }).showTabs;
      return {
        ...next,
        layouts: { ...state.layouts, [scope]: { ...state.layouts[scope], [layoutKey]: workspace } },
      };
    },
  },
  {
    layouts: {
      type: "object",
      noNull: true,
      noUndefined: true,
      description: () => "Resetting invalid saved panel layouts",
      elements: {
        _: {
          type: "object",
          noNull: true,
          noUndefined: true,
          deleteBroken: true,
          description: () => "Removing invalid panel layouts for a game",
          elements: {
            _: {
              type: "object",
              noNull: true,
              noUndefined: true,
              deleteBroken: true,
              description: () => "Removing an invalid panel layout",
            },
          },
        },
      },
    },
  },
);
