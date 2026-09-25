import { fireEvent, render, screen, within } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { addPanel, addTab, createWorkspace, type IPanelWorkspace } from "@/util/panelLayout";

import { PanelChooser } from "./PanelChooser";
import { PanelTabs } from "./PanelTabs";
import { PanelToolbar } from "./PanelToolbar";

const mocks = vi.hoisted(() => ({
  state: undefined as unknown as IPanelWorkspace,
  navigationPages: [
    { id: "Mods", title: "Mods", icon: "mods", group: "per-game" },
    { id: "Plugins", title: "Plugins", icon: "plugins", group: "per-game" },
  ],
  add: vi.fn(),
  close: vi.fn(),
  newTab: vi.fn(),
  select: vi.fn(),
  toggleTabs: vi.fn(),
}));
vi.mock("./PanelContext", () => ({
  usePanels: () => ({
    workspace: mocks.state,
    pages: [
      { id: "Mods", title: "Mods", icon: "mods", group: "per-game" },
      { id: "Plugins", title: "Plugins", icon: "plugins", group: "per-game" },
      { id: "Dashboard", title: "Dashboard", icon: "dashboard", group: "global" },
    ],
    navigationPages: mocks.navigationPages,
    add: mocks.add,
    close: mocks.close,
    newTab: mocks.newTab,
    select: mocks.select,
    showTabs: true,
    toggleTabs: mocks.toggleTabs,
    isHorizontal: true,
    activate: vi.fn(),
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

describe("panel chrome from the design", () => {
  it("keeps a single tab visible and puts the new-tab action in its bar", () => {
    const { container } = render(<PanelTabs panel={mocks.state.panels["panel-1"]} />);
    expect(screen.getByRole("tab", { name: "Mods" })).toBeVisible();
    expect(container.querySelector("[data-panel-tabbar]")).toHaveClass("bg-surface-panel-bar");
    expect(screen.getByRole("tab", { name: "Mods" }).parentElement).toHaveClass("h-full");
    expect(screen.getByRole("tab", { name: "Mods" }).parentElement).not.toHaveClass("rounded-sm");
    expect(
      within(container.querySelector("[data-panel-actions]") as HTMLElement).getByRole("button", {
        name: "Open new tab",
      }),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Close Mods tab" })).toBeNull();
  });
  it("uses the New tab picker and one close control in an empty new panel", () => {
    mocks.state = addPanel(mocks.state);
    const panel = mocks.state.panels[mocks.state.focusedPanel];
    const { container } = render(
      <>
        <PanelTabs panel={panel} />
        <PanelChooser panelId={panel.id} tabId={panel.activeTab} />
      </>,
    );
    const chooser = container.querySelector('[data-panel-chooser="tab"]') as HTMLElement;
    expect(chooser).toHaveClass("bg-surface-base");
    expect(within(chooser).queryByRole("textbox")).toBeNull();
    const firstChoice = chooser.querySelector("[data-panel-choice]") as HTMLButtonElement;
    expect(firstChoice).toHaveFocus();
    expect(firstChoice).toHaveClass("h-10", "w-full");
    expect(firstChoice).not.toHaveClass("nxm-button");
    expect(chooser.querySelector('[data-panel-choice="Dashboard"]')).toBeNull();
    expect(chooser.querySelector('[data-panel-choice="Mods"]')).toBeNull();
    expect(chooser.querySelector('[data-panel-choice="Plugins"]')).not.toBeNull();
    expect(within(chooser).queryByRole("heading")).toBeNull();
    expect(screen.getByRole("tab", { name: "New tab" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "New tab" }).querySelector("img")).toHaveAttribute(
      "src",
      "assets/panels/tab.svg",
    );
    expect(screen.getByRole("button", { name: "Close new panel" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Cancel page selection" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Add a panel for split screen viewing" }),
    ).toBeNull();
  });
  it("shows unopened game pages as sidebar rows in a tab named New tab", () => {
    mocks.state = addTab(mocks.state);
    mocks.state = { ...mocks.state, recent: ["Dashboard", "Mods"] };
    const panel = mocks.state.panels[mocks.state.focusedPanel];
    const { container } = render(
      <>
        <PanelTabs panel={panel} />
        <PanelChooser panelId={panel.id} tabId={panel.activeTab} />
      </>,
    );
    const chooser = container.querySelector('[data-panel-chooser="tab"]') as HTMLElement;
    expect(chooser).toHaveClass("bg-surface-base");
    expect(within(chooser).queryByRole("textbox")).toBeNull();
    expect(chooser.querySelector("[data-panel-discovery]")).toBeNull();
    const choice = chooser.querySelector('[data-panel-choice="Plugins"]') as HTMLButtonElement;
    expect(choice).toHaveFocus();
    expect(choice).toHaveClass("h-10", "w-full");
    expect(choice).not.toHaveClass("nxm-button");
    expect(chooser.querySelector('[data-panel-choice="Dashboard"]')).toBeNull();
    expect(chooser.querySelector('[data-panel-choice="Mods"]')).toBeNull();
    expect(within(chooser).queryByRole("heading")).toBeNull();
    expect(screen.getByRole("tab", { name: "New tab" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "New tab" }).parentElement).toHaveClass("h-full");
    expect(screen.getByRole("tab", { name: "New tab" }).parentElement).not.toHaveClass(
      "rounded-sm",
    );
    expect(screen.queryByRole("button", { name: "Cancel page selection" })).toBeNull();
    fireEvent.click(choice);
    expect(mocks.select).toHaveBeenCalledWith(panel.id, panel.activeTab, "Plugins");
  });
  it("offers only unopened Home sidebar pages in a Home panel", () => {
    mocks.state = addPanel(createWorkspace("Dashboard"));
    mocks.navigationPages = [
      { id: "Dashboard", title: "Dashboard", icon: "dashboard", group: "global" },
      { id: "Games", title: "Games", icon: "games", group: "global" },
      { id: "Extensions", title: "Extensions", icon: "extensions", group: "global" },
    ];
    const panel = mocks.state.panels[mocks.state.focusedPanel];
    const { container } = render(<PanelChooser panelId={panel.id} tabId={panel.activeTab} />);
    const chooser = container.querySelector('[data-panel-chooser="tab"]') as HTMLElement;
    expect(chooser.querySelector('[data-panel-choice="Dashboard"]')).toBeNull();
    expect(chooser.querySelector('[data-panel-choice="Games"]')).not.toBeNull();
    expect(chooser.querySelector('[data-panel-choice="Extensions"]')).not.toBeNull();
    expect(chooser.querySelector('[data-panel-choice="Mods"]')).toBeNull();
    fireEvent.click(within(chooser).getByRole("button", { name: "Games" }));
    expect(mocks.select).toHaveBeenCalledWith(panel.id, panel.activeTab, "Games");
  });
  it("keeps split-panel actions inside Vortex without a pop-out control", () => {
    mocks.state = addPanel(mocks.state, "right", "Plugins");
    const { container } = render(<PanelTabs panel={mocks.state.panels["panel-1"]} />);
    const actions = within(container.querySelector("[data-panel-actions]") as HTMLElement);
    expect(actions.getAllByRole("button")).toHaveLength(2);
    expect(actions.queryByRole("button", { name: /new window/ })).toBeNull();
    fireEvent.click(actions.getByRole("button", { name: "Open new tab" }));
    expect(mocks.newTab).toHaveBeenCalledWith("panel-1");
    fireEvent.click(actions.getByRole("button", { name: /Close.*panel/ }));
    expect(mocks.close).toHaveBeenCalledWith("panel-1");
  });
  it("has an explicit position dropdown and an icon for the next clockwise placement", () => {
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
    expect(screen.queryByRole("button", { name: "Open new tab" })).toBeNull();
  });
  it("offers the tab-free variant in the panel position menu", () => {
    render(<PanelToolbar />);
    fireEvent.click(screen.getByRole("button", { name: "Choose panel position" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Hide panel tabs" }));
    expect(mocks.toggleTabs).toHaveBeenCalledOnce();
  });
});
