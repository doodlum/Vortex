import { describe, expect, it } from "vitest";

import {
  activePage,
  addPanel,
  addTab,
  closePanel,
  closeTab,
  createWorkspace,
  defaultPlacement,
  initialPanelWorkspace,
  isPanelWorkspace,
  MAX_TABS,
  navigatePage,
  PANEL_LAYOUT_KEY,
  panelIds,
  panelBounds,
  panelPlacements,
  previewPanelPlacement,
  resizePanel,
  selectPage,
} from "./panelLayout";

describe("panel workspace", () => {
  it("migrates the current page layout once and then uses one saved game layout", () => {
    const mods = createWorkspace("Mods", "Plugins");
    const tools = createWorkspace("Tools");
    const oldLayouts = { Mods: mods, Tools: tools };
    expect(initialPanelWorkspace(oldLayouts, "Mods")).toBe(mods);
    expect(initialPanelWorkspace(oldLayouts, "Tools")).toBe(tools);
    const shared = { ...oldLayouts, [PANEL_LAYOUT_KEY]: mods };
    expect(initialPanelWorkspace(shared, "Tools")).toBe(mods);
    expect(initialPanelWorkspace(shared, "Health check")).toBe(mods);
  });
  it("activates an existing inactive tab in place", () => {
    let state = addTab(createWorkspace("Mods"));
    state = selectPage(state, "panel-1", state.panels["panel-1"].activeTab, "Plugins");
    state = addPanel(state, "right", "Save games");
    const before = state.panels["panel-1"].tabs;
    const next = navigatePage(state, "Mods");
    expect(next.root).toBe(state.root);
    expect(next.panels["panel-1"].tabs).toBe(before);
    expect(next.panels["panel-1"].activeTab).toBe("tab-1");
    expect(next.focusedPanel).toBe("panel-1");
    expect(activePage(next.panels["panel-1"])).toBe("Mods");
  });
  it("replaces the active tab in the focused panel even when it is shorter", () => {
    let state = addPanel(createWorkspace("Mods"), "right", "Plugins");
    state = addPanel(state, "bottom-right", "Save games");
    state = addTab(state, "panel-1");
    state = selectPage(state, "panel-1", state.panels["panel-1"].activeTab, "Collections");
    const narrowPanel = Object.values(state.panels).find((panel) =>
      panel.tabs.some((tab) => tab.pageId === "Save games"),
    )!;
    state = selectPage(state, narrowPanel.id, narrowPanel.activeTab, "Save games");
    const next = navigatePage(state, "Tools");
    expect(next.root).toBe(state.root);
    expect(next.focusedPanel).toBe(narrowPanel.id);
    expect(next.panels["panel-1"].tabs.map((tab) => tab.pageId)).toEqual(["Mods", "Collections"]);
    expect(activePage(next.panels[narrowPanel.id])).toBe("Tools");
  });
  it("replaces the focused panel even when another panel is wider", () => {
    let state = addPanel(createWorkspace("Mods"), "right", "Plugins");
    state = resizePanel(state, state.root.id, 70);
    const next = navigatePage(state, "Health check");
    expect(next.focusedPanel).toBe(state.focusedPanel);
    expect(activePage(next.panels["panel-1"])).toBe("Mods");
    expect(activePage(next.panels[state.focusedPanel])).toBe("Health check");
  });
  it("migrates saved game/page partners and adds with a four-panel limit", () => {
    let state = createWorkspace("Mods", "Plugins");
    expect(panelIds(state.root)).toHaveLength(2);
    expect(defaultPlacement(state.root)).toBe("bottom-right");
    state = addPanel(state, undefined, "Downloads");
    expect(defaultPlacement(state.root)).toBe("bottom-left");
    state = addPanel(state, undefined, "Settings");
    expect(panelPlacements(state.root)).toEqual([]);
    expect(addPanel(state)).toBe(state);
    expect(isPanelWorkspace(state)).toBe(true);
  });
  it("supports every legal placement and closing any leaf without losing the others", () => {
    const explore = (state: ReturnType<typeof createWorkspace>) => {
      expect(isPanelWorkspace(state)).toBe(true);
      for (const id of panelIds(state.root)) {
        const next = closePanel(state, id);
        expect(isPanelWorkspace(next)).toBe(true);
        expect(Object.keys(next.panels)).toHaveLength(
          Math.max(1, Object.keys(state.panels).length - 1),
        );
      }
      for (const { position } of panelPlacements(state.root))
        explore(addPanel(state, position, `page-${state.nextId}`));
    };
    explore(createWorkspace("Mods"));
  });
  it("uses Nexus-style orientation and grid ordering for the next panel", () => {
    const columns = addPanel(createWorkspace("Mods"), "right", "Plugins");
    const rows = addPanel(createWorkspace("Mods"), "bottom", "Plugins");
    expect(defaultPlacement(createWorkspace("Mods").root, true)).toBe("right");
    expect(defaultPlacement(createWorkspace("Mods").root, false)).toBe("bottom");
    expect(defaultPlacement(columns.root, true)).toBe("bottom-right");
    expect(defaultPlacement(columns.root, false)).toBe("bottom");
    expect(defaultPlacement(rows.root, true)).toBe("top-right");
    expect(defaultPlacement(rows.root, false)).toBe("bottom-right");
  });
  it("draws the candidate from resized bounds and aligns the fourth-panel divider", () => {
    let state = addPanel(createWorkspace("Mods"), "right", "Plugins");
    state = resizePanel(state, state.root.id, 65);
    const choice = panelPlacements(state.root).find((item) => item.position === "bottom-right")!;
    const preview = panelBounds(previewPanelPlacement(state.root, choice));
    expect(preview.find((panel) => panel.id === "panel-1")?.width).toBeCloseTo(0.65);
    expect(preview.find((panel) => panel.id === "__new-panel")?.x).toBeCloseTo(0.65);
    state = addPanel(state, "bottom-right", "Save games");
    const right = state.root.kind === "split" ? state.root.second : undefined;
    expect(right?.kind).toBe("split");
    state = resizePanel(state, right!.id, 60);
    state = addPanel(state, "bottom-left", "Tools");
    const left = state.root.kind === "split" ? state.root.first : undefined;
    expect(left).toMatchObject({ kind: "split", ratio: 60 });
    expect(isPanelWorkspace(state)).toBe(true);
  });
  it("moves the pending panel instead of creating extra blank panels", () => {
    const state = addPanel(createWorkspace("Mods"));
    const moved = addPanel(state, "bottom");
    expect(panelIds(moved.root)).toHaveLength(2);
    expect(moved.root).toMatchObject({ kind: "split", axis: "y" });
    expect(isPanelWorkspace(moved)).toBe(true);
  });
  it("focuses a single page instance and cancels the chooser", () => {
    const state = addPanel(createWorkspace("Mods", "Plugins"));
    const selected = selectPage(
      state,
      state.focusedPanel,
      state.panels[state.focusedPanel].activeTab,
      "Mods",
    );
    expect(panelIds(selected.root)).toHaveLength(2);
    expect(selected.focusedPanel).toBe("panel-1");
    expect(isPanelWorkspace(selected)).toBe(true);
  });
  it("keeps tab selection valid after closing and enforces the tab limit", () => {
    let state = createWorkspace("Mods");
    for (let index = 1; index < MAX_TABS; index++) {
      state = addTab(state);
      state = selectPage(
        state,
        state.focusedPanel,
        state.panels[state.focusedPanel].activeTab,
        `page-${index}`,
      );
    }
    expect(addTab(state)).toBe(state);
    const panel = state.panels[state.focusedPanel];
    state = closeTab(state, panel.id, panel.activeTab);
    expect(activePage(state.panels[panel.id])).toBe("page-14");
    expect(isPanelWorkspace(state)).toBe(true);
  });
  it("bounds resize ratios and rejects corrupt persisted trees", () => {
    const state = createWorkspace("Mods", "Plugins");
    expect(resizePanel(state, state.root.id, 200).root).toMatchObject({ ratio: 80 });
    expect(resizePanel(state, state.root.id, NaN)).toBe(state);
    expect(isPanelWorkspace({ ...state, panels: {} })).toBe(false);
    expect(isPanelWorkspace({ ...state, root: { ...state.root, ratio: null } })).toBe(false);
    expect(isPanelWorkspace({ ...state, nextId: 0 })).toBe(false);
    expect(isPanelWorkspace({ ...state, focusedPanel: "missing" })).toBe(false);
    expect(
      isPanelWorkspace({
        ...state,
        panels: { ...state.panels, "panel-1": { ...state.panels["panel-1"], tabs: [null] } },
      }),
    ).toBe(false);
  });
});
