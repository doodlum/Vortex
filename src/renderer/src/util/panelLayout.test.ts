import { describe, expect, it } from "vitest";

import {
  addPanel,
  closePanel,
  createWorkspace,
  defaultPlacement,
  initialPanelWorkspace,
  isPanelWorkspace,
  migratePanelWorkspace,
  navigatePage,
  PANEL_LAYOUT_KEY,
  panelBounds,
  panelIds,
  panelPlacements,
  previewPanelPlacement,
  resizePanel,
  selectPage,
} from "./panelLayout";

describe("panel workspace", () => {
  it("migrates selected pages from tabbed panels without changing geometry", () => {
    const base = resizePanel(createWorkspace("Mods", "Plugins"), "split-panel-2", 63);
    const legacy = {
      ...base,
      panels: {
        "panel-1": {
          id: "panel-1",
          tabs: [
            { id: "tab-1", pageId: "Mods" },
            { id: "tab-3", pageId: "Tools" },
          ],
          activeTab: "tab-3",
        },
        "panel-2": {
          id: "panel-2",
          placement: "right",
          tabs: [{ id: "tab-2", pageId: "Plugins" }],
          activeTab: "tab-2",
        },
      },
    };
    const migrated = migratePanelWorkspace(legacy)!;
    expect(migrated.root).toEqual(base.root);
    expect(migrated.focusedPanel).toBe(base.focusedPanel);
    expect(migrated.panels).toEqual({
      "panel-1": { id: "panel-1", pageId: "Tools" },
      "panel-2": { id: "panel-2", placement: "right", pageId: "Plugins" },
    });
    expect(initialPanelWorkspace({ [PANEL_LAYOUT_KEY]: legacy } as never, "Mods")).toEqual(
      migrated,
    );
    expect(initialPanelWorkspace({ Mods: legacy } as never, "Mods")).toEqual(migrated);
    expect(
      migratePanelWorkspace({
        ...legacy,
        panels: {
          ...legacy.panels,
          "panel-1": { ...legacy.panels["panel-1"], activeTab: "missing" },
        },
      }),
    ).toBeUndefined();
  });
  it("uses one saved workspace per game", () => {
    const mods = createWorkspace("Mods", "Plugins");
    const tools = createWorkspace("Tools");
    expect(initialPanelWorkspace({ Mods: mods, Tools: tools }, "Mods")).toBe(mods);
    expect(initialPanelWorkspace({ Mods: mods, Tools: tools }, "Tools")).toBe(tools);
    expect(initialPanelWorkspace({ Mods: mods, [PANEL_LAYOUT_KEY]: tools }, "Mods")).toBe(tools);
  });
  it("focuses an open page and replaces only the focused panel for a new page", () => {
    const state = addPanel(createWorkspace("Mods"), "right", "Plugins");
    const mods = navigatePage(state, "Mods");
    expect(mods.root).toBe(state.root);
    expect(mods.focusedPanel).toBe("panel-1");
    const tools = navigatePage(mods, "Tools");
    expect(tools.panels["panel-1"].pageId).toBe("Tools");
    expect(tools.panels["panel-2"].pageId).toBe("Plugins");
    expect(tools.root).toBe(state.root);
  });
  it("fills a blank panel or cancels it when choosing an existing page", () => {
    const blank = addPanel(createWorkspace("Mods", "Plugins"));
    const chosen = selectPage(blank, blank.focusedPanel, "Tools");
    expect(chosen.panels[chosen.focusedPanel].pageId).toBe("Tools");
    const existing = selectPage(blank, blank.focusedPanel, "Mods");
    expect(panelIds(existing.root)).toHaveLength(2);
    expect(existing.focusedPanel).toBe("panel-1");
    expect(isPanelWorkspace(existing)).toBe(true);
  });
  it("supports every placement and closing any leaf up to four panels", () => {
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
  it("uses orientation and grid shape for placement", () => {
    const columns = addPanel(createWorkspace("Mods"), "right", "Plugins");
    const rows = addPanel(createWorkspace("Mods"), "bottom", "Plugins");
    expect(defaultPlacement(createWorkspace("Mods").root, true)).toBe("right");
    expect(defaultPlacement(createWorkspace("Mods").root, false)).toBe("bottom");
    expect(defaultPlacement(columns.root, true)).toBe("bottom-right");
    expect(defaultPlacement(columns.root, false)).toBe("bottom");
    expect(defaultPlacement(rows.root, true)).toBe("top-right");
    expect(defaultPlacement(rows.root, false)).toBe("bottom-right");
  });
  it("uses resized geometry in the icon preview and aligns the fourth divider", () => {
    let state = addPanel(createWorkspace("Mods"), "right", "Plugins");
    state = resizePanel(state, state.root.id, 65);
    const choice = panelPlacements(state.root).find((item) => item.position === "bottom-right")!;
    const preview = panelBounds(previewPanelPlacement(state.root, choice));
    expect(preview.find((panel) => panel.id === "panel-1")?.width).toBeCloseTo(0.65);
    expect(preview.find((panel) => panel.id === "__new-panel")?.x).toBeCloseTo(0.65);
    state = addPanel(state, "bottom-right", "Save games");
    const right = state.root.kind === "split" ? state.root.second : undefined;
    state = resizePanel(state, right!.id, 60);
    state = addPanel(state, "bottom-left", "Tools");
    const left = state.root.kind === "split" ? state.root.first : undefined;
    expect(left).toMatchObject({ kind: "split", ratio: 60 });
  });
  it("moves an unfilled panel and rejects corrupt layouts", () => {
    const state = addPanel(createWorkspace("Mods"));
    const moved = addPanel(state, "bottom");
    expect(panelIds(moved.root)).toHaveLength(2);
    expect(moved.root).toMatchObject({ kind: "split", axis: "y" });
    expect(resizePanel(moved, moved.root.id, 200).root).toMatchObject({ ratio: 80 });
    expect(resizePanel(moved, moved.root.id, NaN)).toBe(moved);
    expect(isPanelWorkspace({ ...moved, panels: {} })).toBe(false);
    expect(isPanelWorkspace({ ...moved, root: { ...moved.root, ratio: null } })).toBe(false);
    expect(isPanelWorkspace({ ...moved, nextId: 0 })).toBe(false);
    expect(isPanelWorkspace({ ...moved, focusedPanel: "missing" })).toBe(false);
    expect(
      isPanelWorkspace({ ...moved, panels: { ...moved.panels, "panel-1": { id: "panel-1" } } }),
    ).toBe(false);
  });
});
