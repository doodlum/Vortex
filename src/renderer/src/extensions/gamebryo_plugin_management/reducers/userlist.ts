import type { IReducerSpec } from "../../../types/IExtensionContext";
import {
  addUniqueSafe,
  deleteOrNop,
  pushSafe,
  removeValue,
  removeValueIf,
  setSafe,
} from "../../../util/storeHelper";
import * as actions from "../actions/userlist";
import { referencesMatch } from "../util/lootReference";

type RuleType = "after" | "requires" | "incompatible";

function listForType(type: string) {
  switch (type) {
    case "requires":
      return "req";
    case "incompatible":
      return "inc";
    default:
      return "after";
  }
}

/**
 * reducer for changes to settings regarding mods
 */
const userlistReducer: IReducerSpec = {
  reducers: {
    ["persist/REHYDRATE"]: (state, payload) => {
      if (payload.hasOwnProperty("userlist")) {
        return setSafe(state, [], payload.userlist);
      } else {
        return state;
      }
    },
    [actions.addRule as any]: (state, payload) => {
      let existing: number = -1;
      if (state.plugins !== undefined) {
        existing = state.plugins.findIndex(
          (plug) => plug.name.toUpperCase() === payload.pluginId.toUpperCase(),
        );
      }
      const list = listForType(payload.type);
      if (existing !== -1) {
        const rules = state.plugins[existing][list] ?? [];
        return rules.some((reference) => referencesMatch(reference, payload.reference))
          ? state
          : {
              ...state,
              plugins: state.plugins.map((plugin, index) =>
                index === existing ? { ...plugin, [list]: [...rules, payload.reference] } : plugin,
              ),
            };
      } else {
        return {
          ...state,
          plugins: [
            ...(state.plugins ?? []),
            {
              name: payload.pluginId,
              [list]: [payload.reference],
            },
          ],
        };
      }
    },
    [actions.removeRule as any]: (state, payload) => {
      let existing: number = -1;
      if (state.plugins !== undefined) {
        existing = state.plugins.findIndex(
          (plug) => plug.name.toUpperCase() === payload.pluginId.toUpperCase(),
        );
      }
      const list = listForType(payload.type);
      if (existing !== -1) {
        const rules = state.plugins[existing][list] ?? [];
        const retained = rules.filter(
          (reference) => !referencesMatch(reference, payload.reference),
        );
        return retained.length === rules.length
          ? state
          : {
              ...state,
              plugins: state.plugins.map((plugin, index) =>
                index === existing ? { ...plugin, [list]: retained } : plugin,
              ),
            };
      } else {
        return state;
      }
    },
    [actions.addGroup as any]: (state, payload) =>
      state.groups.find((group) => group.name.toUpperCase() === payload.group.toUpperCase()) ===
      undefined
        ? pushSafe(state, ["groups"], {
            name: payload.group,
            after: [],
          })
        : state,
    [actions.removeGroup as any]: (state, payload) => {
      // need to remove the group from all rules
      state.groups.forEach((group, idx) => {
        state = removeValue(state, ["groups", idx, "after"], payload.group);
      });

      state.plugins.forEach((plugin, idx) => {
        if (
          plugin.group !== undefined &&
          payload.group !== undefined &&
          plugin.group.toUpperCase() === payload.group.toUpperCase()
        ) {
          state = setSafe(state, ["plugins", idx, "group"], "default");
        }
      });

      return removeValueIf(
        state,
        ["groups"],
        (group) => group.name.toUpperCase() === payload.group.toUpperCase(),
      );
    },
    [actions.setGroup as any]: (state, payload) => {
      let existing: number = -1;
      if (state.plugins !== undefined) {
        existing = state.plugins.findIndex(
          (plug) => plug.name.toUpperCase() === payload.pluginId.toUpperCase(),
        );
      }

      if (payload.group === undefined) {
        return existing !== -1 ? deleteOrNop(state, ["plugins", existing, "group"]) : state;
      }

      return existing !== -1
        ? setSafe(state, ["plugins", existing, "group"], payload.group)
        : pushSafe(state, ["plugins"], {
            name: payload.pluginId,
            group: payload.group,
          });
    },
    [actions.addGroupRule as any]: (state, payload) => {
      const idx = state.groups.findIndex(
        (group) => group.name.toUpperCase() === payload.groupId.toUpperCase(),
      );
      if (idx === -1) {
        return pushSafe(state, ["groups"], {
          name: payload.groupId,
          after: [payload.reference],
        });
      } else {
        return addUniqueSafe(state, ["groups", idx, "after"], payload.reference);
      }
    },
    [actions.clearUserlist as any]: () => ({ plugins: [], groups: [] }),
    [actions.removeGroupRule as any]: (state, payload) => {
      const idx = state.groups.findIndex(
        (group) => group.name.toUpperCase() === payload.groupId.toUpperCase(),
      );
      if (idx === -1) {
        return state;
      }
      return removeValue(state, ["groups", idx, "after"], payload.reference);
    },
  },
  defaults: { plugins: [], groups: [] },
};

export default userlistReducer;
