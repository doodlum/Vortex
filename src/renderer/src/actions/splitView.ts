import { createAction } from "redux-act";

/** Save a right-hand page for one game's primary page; empty removes the pairing. */
export const setSplitView = createAction(
  "SET_SPLIT_VIEW",
  (gameId: string, primaryPage: string, secondaryPage: string) => ({
    gameId,
    primaryPage,
    secondaryPage,
  }),
);
