import { describe, expect, it } from "vitest";

import { createWorkspace } from "../util/panelLayout";
import { panelsReducer } from "./panels";

describe("saved sidebar layouts", () => {
  it("stores each page separately and can remove one without changing its neighbors", () => {
    const mods = createWorkspace("Mods");
    const plugins = createWorkspace("Plugins");
    const withMods = panelsReducer.reducers.SET_PANEL_WORKSPACE(panelsReducer.defaults, {
      scope: "fallout4",
      layoutKey: "Mods",
      workspace: mods,
    });
    const withBoth = panelsReducer.reducers.SET_PANEL_WORKSPACE(withMods, {
      scope: "fallout4",
      layoutKey: "Plugins",
      workspace: plugins,
    });
    expect(withBoth.layouts.fallout4).toEqual({ Mods: mods, Plugins: plugins });
    const removed = panelsReducer.reducers.REMOVE_PANEL_WORKSPACE(withBoth, {
      scope: "fallout4",
      layoutKey: "Mods",
    });
    expect(removed.layouts.fallout4).toEqual({ Plugins: plugins });
    expect(withBoth.layouts.fallout4).toEqual({ Mods: mods, Plugins: plugins });
  });
});
