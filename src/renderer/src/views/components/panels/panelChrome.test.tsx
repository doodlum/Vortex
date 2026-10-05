import { mdiDockRight } from "@mdi/js";
import { fireEvent, render, screen, within } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createWorkspace, openSplitView, type IPanelWorkspace } from "@/util/panelLayout";

import { PanelChooser } from "./PanelChooser";
import { SplitViewButton } from "./SplitViewButton";

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTranslation: () => ({
    t: (key: string, options?: { page?: string }) =>
      key.replace("{{page}}", options?.page ?? "{{page}}"),
  }),
}));

const mocks = vi.hoisted(() => ({
  state: undefined as unknown as IPanelWorkspace,
  navigationPages: [
    { id: "Mods", title: "Mods", icon: "mods", group: "per-game" },
    { id: "Plugins", title: "Plugins", icon: "plugins", group: "per-game" },
  ],
  select: vi.fn(),
}));
vi.mock("./PanelContext", () => ({
  usePanels: () => ({
    workspace: mocks.state,
    navigationPages: mocks.navigationPages,
    select: mocks.select,
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

describe("split view controls", () => {
  it("centres the headerless chooser and offers only unopened game pages", () => {
    mocks.state = openSplitView(mocks.state);
    const panelId = mocks.state.root.kind === "split" ? mocks.state.root.second.id : "";
    const panel = mocks.state.panels[panelId];
    const { container } = render(<PanelChooser panelId={panel.id} />);
    const chooser = container.querySelector('[data-panel-chooser="panel"]') as HTMLElement;
    expect(chooser).toHaveClass("flex", "bg-surface-base");
    expect(chooser.firstElementChild).toHaveClass("m-auto");
    expect(chooser.querySelector("header, h1, h2")).toBeNull();
    expect(within(chooser).queryByRole("textbox")).toBeNull();
    expect(chooser.querySelector('[data-panel-choice="Mods"]')).toBeNull();
    const choice = chooser.querySelector('[data-panel-choice="Plugins"]') as HTMLButtonElement;
    expect(choice).toHaveFocus();
    fireEvent.click(choice);
    expect(mocks.select).toHaveBeenCalledWith(panel.id, "Plugins");
  });

  it("offers only Home pages in a Home split", () => {
    mocks.state = openSplitView(createWorkspace("Dashboard"));
    mocks.navigationPages = [
      { id: "Dashboard", title: "Dashboard", icon: "dashboard", group: "global" },
      { id: "Games", title: "Games", icon: "games", group: "global" },
      { id: "Extensions", title: "Extensions", icon: "extensions", group: "global" },
    ];
    const panelId = mocks.state.root.kind === "split" ? mocks.state.root.second.id : "";
    const panel = mocks.state.panels[panelId];
    const { container } = render(<PanelChooser panelId={panel.id} />);
    const chooser = container.querySelector('[data-panel-chooser="panel"]') as HTMLElement;
    expect(chooser.querySelector('[data-panel-choice="Dashboard"]')).toBeNull();
    expect(chooser.querySelector('[data-panel-choice="Games"]')).not.toBeNull();
    expect(chooser.querySelector('[data-panel-choice="Extensions"]')).not.toBeNull();
    expect(chooser.querySelector('[data-panel-choice="Mods"]')).toBeNull();
  });

  it("keeps the dock icon and names the page the toggle closes", () => {
    const onClick = vi.fn();
    const { rerender } = render(
      <SplitViewButton isSplit={false} closePageName="new panel" onClick={onClick} />,
    );
    const enter = screen.getByRole("button", { name: "Enter split view" });
    expect(enter.querySelector("path")?.getAttribute("d")).toBe(mdiDockRight);
    expect(enter).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(enter);
    expect(onClick).toHaveBeenCalledOnce();
    rerender(<SplitViewButton isSplit closePageName="Plugins" onClick={onClick} />);
    const close = screen.getByRole("button", { name: "Close Plugins" });
    expect(close.querySelector("path")?.getAttribute("d")).toBe(mdiDockRight);
    expect(close).toHaveAttribute("aria-pressed", "true");
    expect(close).toHaveClass("bg-surface-translucent-mid", "border-stroke-moderate");
    rerender(<SplitViewButton isSplit closePageName="new panel" onClick={onClick} />);
    expect(screen.getByRole("button", { name: "Close new panel" })).toBeInTheDocument();
  });
});
