import { fireEvent, render, screen, within } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { addPanel, createWorkspace, type IPanelWorkspace } from "@/util/panelLayout";

import { PanelChooser } from "./PanelChooser";
import { PanelToolbar } from "./PanelToolbar";

const mocks = vi.hoisted(() => ({
  state: undefined as unknown as IPanelWorkspace,
  navigationPages: [
    { id: "Mods", title: "Mods", icon: "mods", group: "per-game" },
    { id: "Plugins", title: "Plugins", icon: "plugins", group: "per-game" },
  ],
  add: vi.fn(),
  select: vi.fn(),
}));
vi.mock("./PanelContext", () => ({
  usePanels: () => ({
    workspace: mocks.state,
    navigationPages: mocks.navigationPages,
    add: mocks.add,
    select: mocks.select,
    isHorizontal: true,
  }),
}));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.state = createWorkspace("Mods");
  mocks.navigationPages = [
    { id: "Mods", title: "Mods", icon: "mods", group: "per-game" },
    { id: "Plugins", title: "Plugins", icon: "plugins", group: "per-game" },
  ];
});

describe("panel controls", () => {
  it("offers only unopened game pages in a new panel", () => {
    mocks.state = addPanel(mocks.state);
    const panel = mocks.state.panels[mocks.state.focusedPanel];
    const { container } = render(<PanelChooser panelId={panel.id} />);
    const chooser = container.querySelector('[data-panel-chooser="panel"]') as HTMLElement;
    expect(chooser).toHaveClass("bg-surface-base");
    expect(within(chooser).queryByRole("textbox")).toBeNull();
    expect(chooser.querySelector('[data-panel-choice="Mods"]')).toBeNull();
    const choice = chooser.querySelector('[data-panel-choice="Plugins"]') as HTMLButtonElement;
    expect(choice).toHaveFocus();
    expect(choice).toHaveClass("h-10", "w-full");
    fireEvent.click(choice);
    expect(mocks.select).toHaveBeenCalledWith(panel.id, "Plugins");
  });
  it("offers only Home pages in a Home panel", () => {
    mocks.state = addPanel(createWorkspace("Dashboard"));
    mocks.navigationPages = [
      { id: "Dashboard", title: "Dashboard", icon: "dashboard", group: "global" },
      { id: "Games", title: "Games", icon: "games", group: "global" },
      { id: "Extensions", title: "Extensions", icon: "extensions", group: "global" },
    ];
    const panel = mocks.state.panels[mocks.state.focusedPanel];
    const { container } = render(<PanelChooser panelId={panel.id} />);
    const chooser = container.querySelector('[data-panel-chooser="panel"]') as HTMLElement;
    expect(chooser.querySelector('[data-panel-choice="Dashboard"]')).toBeNull();
    expect(chooser.querySelector('[data-panel-choice="Games"]')).not.toBeNull();
    expect(chooser.querySelector('[data-panel-choice="Extensions"]')).not.toBeNull();
    expect(chooser.querySelector('[data-panel-choice="Mods"]')).toBeNull();
    fireEvent.click(within(chooser).getByRole("button", { name: "Games" }));
    expect(mocks.select).toHaveBeenCalledWith(panel.id, "Games");
  });
  it("offers legal panel positions with an adaptive icon and no tab setting", () => {
    mocks.state = addPanel(mocks.state, "right", "Plugins");
    render(<PanelToolbar />);
    const opener = screen.getByRole("button", { name: "Add panel" });
    expect(
      opener.querySelector("svg[data-panel-icon-preview] rect[fill='currentColor']"),
    ).toBeVisible();
    expect(opener.querySelectorAll("svg[data-panel-icon-preview] rect")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "Choose panel position" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Bottom row" }));
    expect(mocks.add).toHaveBeenCalledWith("bottom");
    expect(screen.queryByRole("menuitem", { name: /panel tabs/i })).toBeNull();
  });
});
