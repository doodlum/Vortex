import { describe, expect, it } from "vitest";

import {
  collapseToPanel,
  createWorkspace,
  fitSplitRatio,
  initialPanelWorkspace,
  isPanelWorkspace,
  normalizeSidebarWorkspace,
  openSplitView,
  panelIds,
  resizePanel,
  selectPage,
} from "./panelLayout";

const split = (page: string, partner: string) =>
  selectPage(openSplitView(createWorkspace(page)), "panel-2", partner);

describe("sidebar split workspaces", () => {
  it("opens a blank right pane and forgets its partner when closed", () => {
    const opened = openSplitView(createWorkspace("Mods"));
    expect(opened.root).toMatchObject({ kind: "split", axis: "x", ratio: 50 });
    expect(opened.panels["panel-2"].pageId).toBe("");
    const withPlugins = selectPage(opened, "panel-2", "Plugins");
    expect(withPlugins.panels["panel-2"].pageId).toBe("Plugins");
    expect(selectPage(withPlugins, "panel-2", "Mods")).toBe(withPlugins);
    const closed = collapseToPanel(withPlugins, "panel-1");
    expect(panelIds(closed.root)).toEqual(["panel-1"]);
    expect(openSplitView(closed).panels["panel-3"].pageId).toBe("");
    expect(collapseToPanel(withPlugins, "panel-2").panels["panel-2"].pageId).toBe("Plugins");
  });

  it("restores independent per-sidebar layouts without borrowing another page's split", () => {
    const mods = split("Mods", "Plugins");
    const tools = split("Tools", "Game settings");
    expect(initialPanelWorkspace({ Mods: mods, Tools: tools }, "Mods")).toBe(mods);
    expect(initialPanelWorkspace({ Mods: mods, Tools: tools }, "Tools")).toBe(tools);
    expect(initialPanelWorkspace({ Mods: mods }, "Tools")).toEqual(createWorkspace("Tools"));
    expect(normalizeSidebarWorkspace(tools, "Mods")).toEqual(createWorkspace("Mods"));
  });

  it("does not use the shared key or old tabbed and vertical layouts", () => {
    const mods = split("Mods", "Plugins");
    expect(initialPanelWorkspace({ __workspace: mods }, "Mods")).toEqual(createWorkspace("Mods"));
    const rows = { ...mods, root: { ...mods.root, axis: "y" as const } };
    expect(isPanelWorkspace(rows)).toBe(false);
    expect(initialPanelWorkspace({ Mods: rows } as never, "Mods")).toEqual(createWorkspace("Mods"));
    const tabbed = {
      ...mods,
      panels: {
        ...mods.panels,
        "panel-2": { id: "panel-2", tabs: [{ id: "tab", pageId: "Plugins" }] },
      },
    };
    expect(isPanelWorkspace(tabbed)).toBe(false);
  });

  it("clamps divider size and rejects damaged saved layouts", () => {
    const state = split("Mods", "Plugins");
    expect(resizePanel(state, state.root.id, 200).root).toMatchObject({ ratio: 80 });
    expect(resizePanel(state, state.root.id, NaN)).toBe(state);
    expect(isPanelWorkspace({ ...state, panels: {} })).toBe(false);
    expect(isPanelWorkspace({ ...state, root: { ...state.root, ratio: null } })).toBe(false);
    expect(isPanelWorkspace({ ...state, nextId: 0 })).toBe(false);
    expect(
      isPanelWorkspace({ ...state, panels: { ...state.panels, "panel-1": { id: "panel-1" } } }),
    ).toBe(false);
  });

  it("keeps both panes at least 440px wide when the divider moves", () => {
    expect(fitSplitRatio(80, 1200)).toBeCloseTo(100 - (440 / 1188) * 100);
    expect(fitSplitRatio(20, 1200)).toBeCloseTo((440 / 1188) * 100);
    expect(fitSplitRatio(80, 892)).toBe(50);
    expect(fitSplitRatio(80, 2400)).toBe(80);
  });
});
