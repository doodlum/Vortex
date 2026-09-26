import * as actions from "../actions/splitView";
import type { ISettingsSplitView } from "../types/IState";
import { actionsToReducerSpec } from "./builder";

const defaultState: ISettingsSplitView = { pairs: {} };

export const splitViewReducer = actionsToReducerSpec(
  defaultState,
  actions,
  {
    setSplitView: (state, { gameId, primaryPage, secondaryPage }) => {
      if (!gameId || !primaryPage || primaryPage === secondaryPage) return state;
      const pages = state.pairs[gameId] ?? {};
      if (secondaryPage) {
        return {
          ...state,
          pairs: { ...state.pairs, [gameId]: { ...pages, [primaryPage]: secondaryPage } },
        };
      }
      const { [primaryPage]: _, ...remaining } = pages;
      return { ...state, pairs: { ...state.pairs, [gameId]: remaining } };
    },
  },
  {
    pairs: {
      description: () => "Resetting invalid saved split-view pairings",
      type: "object",
      noUndefined: true,
      noNull: true,
      elements: {
        _: {
          description: () => "Removing invalid split-view pairings for a game",
          type: "object",
          noNull: true,
          noUndefined: true,
          deleteBroken: true,
          elements: {
            _: {
              description: () => "Removing an invalid split-view page",
              type: "string",
              noUndefined: true,
              noEmpty: true,
              deleteBroken: true,
            },
          },
        },
      },
    },
  },
);
