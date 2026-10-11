import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { IDeploymentFeedback } from "@/extensions/mod_management/util/deploymentFeedback";

/** The context values under test, set per case. */
const context = vi.hoisted(() => ({
  menuIsCollapsed: false,
  selectionType: "game" as "game" | "home",
  selectedGameId: "stardewvalley",
  control: vi.fn(),
  feedback: undefined as IDeploymentFeedback | undefined,
  showFailure: vi.fn(),
  needToDeploy: false,
  autoDeploy: false,
  isDeploying: false,
  deployProgress: 0,
  deployStep: undefined as string | undefined,
  deploy: vi.fn(),
  emit: vi.fn(),
  handlePlay: vi.fn(),
  primaryStarter: undefined as unknown,
  visibleTools: [{ id: "tool-1", exePath: "a.exe" }] as unknown[],
}));

vi.mock("@/contexts", () => ({
  useMainContext: () => ({ api: { events: { emit: context.emit } } }),
  useWindowContext: () => ({ menuIsCollapsed: context.menuIsCollapsed }),
}));

vi.mock("@/views/components/Spine/SpineContext", () => ({
  useSpineContext: () => ({
    selection: { type: context.selectionType, gameId: context.selectedGameId },
  }),
}));

vi.mock("../../context/ToolsContext", () => ({
  useToolsContext: () => ({
    gameId: "stardewvalley",
    gameName: "Stardew Valley",
    visibleTools: context.visibleTools,
    primaryStarter: context.primaryStarter,
    primaryToolId: context.primaryStarter ? "tool-1" : undefined,
    isPrimaryRunning: false,
    exclusiveRunning: false,
    isToolRunning: () => false,
    startTool: vi.fn(),
    handlePlay: context.handlePlay,
  }),
}));

vi.mock("@/extensions/mod_management/hooks/useDeploymentControl.hook", () => ({
  useDeploymentControl: (...args: unknown[]) => context.control(...args),
}));

vi.mock("@/extensions/mod_management/hooks/useDeploymentStatus.hook", () => ({
  useDeploymentStatus: () => ({ feedback: context.feedback, showFailure: context.showFailure }),
}));

vi.mock("@/extensions/mod_management/hooks/useDeployMods.hook", () => ({
  useDeployMods: () => ({
    needToDeploy: context.needToDeploy,
    autoDeploy: context.autoDeploy,
    isDeploying: context.isDeploying,
    deployProgress: context.isDeploying ? context.deployProgress : undefined,
    deployStep: context.isDeploying ? context.deployStep : undefined,
    deploy: context.deploy,
  }),
}));

vi.mock("../ToolButton", () => ({
  ToolButton: () => <button data-testid="tool" type="button" />,
}));

import { settleTransitions } from "@/test-utils/transitions";

import { GameActions } from "./GameActions";

describe("GameActions", () => {
  beforeEach(() => {
    context.menuIsCollapsed = false;
    context.selectionType = "game";
    context.selectedGameId = "stardewvalley";
    context.control = vi.fn();
    context.feedback = undefined;
    context.showFailure = vi.fn();
    context.needToDeploy = false;
    context.autoDeploy = false;
    context.isDeploying = false;
    context.deployStep = undefined;
    context.deploy = vi.fn();
    context.emit = vi.fn();
    context.handlePlay = vi.fn();
    context.primaryStarter = undefined;
    context.visibleTools = [{ id: "tool-1", exePath: "a.exe" }];
  });

  it("registers feedback only for the selected game control", async () => {
    const { rerender } = render(<GameActions />);
    expect(context.control).toHaveBeenLastCalledWith("stardewvalley", true);
    context.selectedGameId = "another-game";
    rerender(<GameActions />);
    expect(context.control).toHaveBeenLastCalledWith("stardewvalley", false);
    await settleTransitions();
  });

  it("does not register a hidden control on Home", () => {
    context.selectionType = "home";
    render(<GameActions />);
    expect(context.control).toHaveBeenLastCalledWith("stardewvalley", false);
    expect(screen.queryByTestId("menu-tools")).toBeNull();
  });

  it("lays the row out for the width the menu is at", async () => {
    const { rerender } = render(<GameActions />);

    expect(screen.getByTestId("menu-tools")).toHaveClass("w-full");

    context.menuIsCollapsed = true;
    rerender(<GameActions />);

    expect(screen.getByTestId("menu-tools")).toHaveClass("w-10");

    await settleTransitions();
  });

  // The entry animation is replayed by remounting on the width change, which is what
  // lets Transition own the sequencing instead of a flag cleared by a timer. If the key
  // stopped changing the row would sit still, so this pins the mechanism rather than the
  // animation.
  it("remounts the row when the menu changes width", async () => {
    const { rerender } = render(<GameActions />);
    const before = screen.getByTestId("menu-tools");

    context.menuIsCollapsed = true;
    rerender(<GameActions />);

    expect(screen.getByTestId("menu-tools")).not.toBe(before);

    await settleTransitions();
  });

  it("keeps the same row when nothing about the width changed", async () => {
    const { rerender } = render(<GameActions />);
    const before = screen.getByTestId("menu-tools");

    rerender(<GameActions />);

    expect(screen.getByTestId("menu-tools")).toBe(before);

    await settleTransitions();
  });

  it("leaves the row out when the game has no tools", () => {
    context.visibleTools = [];

    render(<GameActions />);

    expect(screen.queryByTestId("menu-tools")).toBeNull();
  });

  it("shows Apply only while there is something to deploy, and deploys on click", async () => {
    const { rerender } = render(<GameActions />);

    expect(screen.queryByTestId("menu-apply")).toBeNull();
    expect(screen.getByText("Play")).toBeInTheDocument();

    context.needToDeploy = true;
    rerender(<GameActions />);

    fireEvent.click(screen.getByTestId("menu-apply"));
    expect(context.deploy).toHaveBeenCalledOnce();
    expect(context.emit).toHaveBeenCalledWith(
      "analytics-track-mixpanel-event",
      expect.objectContaining({ eventName: "app_apply_clicked" }),
    );

    await settleTransitions();
  });

  it("puts Play before Apply and drops Play's label while Apply is showing", async () => {
    context.needToDeploy = true;

    render(<GameActions />);

    const play = screen.getByRole("button", { name: /^Play/ });
    const apply = screen.getByTestId("menu-apply");

    expect(screen.queryByText("Play")).toBeNull();
    expect(apply).toHaveTextContent("Apply");
    expect(play.compareDocumentPosition(apply) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await settleTransitions();
  });

  it("makes both icon only when the menu is collapsed", async () => {
    context.menuIsCollapsed = true;
    context.needToDeploy = true;

    render(<GameActions />);

    expect(screen.getByRole("button", { name: /^Play/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply" })).not.toHaveTextContent("Apply");

    await settleTransitions();
  });

  it("disables Play while a deployment is running", async () => {
    context.primaryStarter = { id: "tool-1", name: "Stardew Valley", exePath: "a.exe" };
    const { rerender } = render(<GameActions />);

    expect(screen.getByRole("button", { name: /^Play/ })).toHaveAttribute("aria-disabled", "false");

    context.isDeploying = true;
    rerender(<GameActions />);

    // aria-disabled, not disabled, so it still gets the hover its tooltip needs.
    const play = screen.getByRole("button", { name: /^Play/ });
    expect(play).toHaveAttribute("aria-disabled", "true");

    fireEvent.click(play);
    expect(context.handlePlay).not.toHaveBeenCalled();

    await settleTransitions();
  });

  it("turns Apply into a progress bar while deploying, so it can't start a second one", async () => {
    context.needToDeploy = true;
    context.isDeploying = true;
    context.deployProgress = 42;

    render(<GameActions />);

    // A progress bar in the button's place, not a button, so there's nothing to press.
    const apply = screen.getByRole("progressbar", { name: "Applying" });
    expect(apply).toHaveAttribute("aria-valuenow", "42");
    expect(screen.queryByRole("button", { name: /Appl/ })).toBeNull();

    fireEvent.click(apply);
    expect(context.deploy).not.toHaveBeenCalled();
    expect(context.emit).not.toHaveBeenCalled();

    await settleTransitions();
  });

  it("names the step it's on in the progress bar's tooltip", async () => {
    context.needToDeploy = true;
    context.isDeploying = true;
    context.deployStep = "SkyUI";
    render(<GameActions />);

    await userEvent.hover(screen.getByRole("progressbar"));

    expect(await screen.findByText("Applying mod changes")).toBeInTheDocument();
    expect(screen.getByText("SkyUI")).toBeInTheDocument();

    await settleTransitions();
  });

  it("keeps the tooltip up through the click that starts applying", async () => {
    context.needToDeploy = true;
    const { rerender } = render(<GameActions />);
    const apply = screen.getByTestId("menu-apply");
    await userEvent.hover(apply);
    await screen.findByText("Apply your mod changes to the game");

    // A press only: a full click also focuses, and jsdom counts that as keyboard focus.
    fireEvent.pointerDown(apply);
    context.isDeploying = true;
    context.deployStep = "SkyUI";
    rerender(<GameActions />);
    // Longer than a closing tooltip takes to leave, so a closed one can't pass for open.
    await act(() => new Promise((resolve) => setTimeout(resolve, 200)));

    expect(screen.getByText("SkyUI")).toBeInTheDocument();

    await settleTransitions();
  });

  it("keeps the plain tooltip until there's a step to name", async () => {
    context.needToDeploy = true;
    context.isDeploying = true;
    render(<GameActions />);

    await userEvent.hover(screen.getByRole("progressbar"));

    expect(await screen.findByText("Applying mod changes…")).toBeInTheDocument();

    await settleTransitions();
  });

  for (const isCollapsed of [false, true]) {
    it(
      "keeps a failed result reachable with auto deployment enabled, collapsed=" + isCollapsed,
      async () => {
        context.menuIsCollapsed = isCollapsed;
        context.autoDeploy = true;
        context.feedback = {
          gameId: "stardewvalley",
          profileId: "p",
          requestId: "r",
          state: "failed",
          changedAt: 1,
          error: { title: "Failure", content: { text: "Detail" } },
        };
        render(<GameActions />);
        const apply = screen.getByRole("button", { name: "Deployment failed" });
        fireEvent.click(apply);
        expect(context.showFailure).toHaveBeenCalledOnce();
        expect(context.deploy).not.toHaveBeenCalled();
        expect(context.emit).not.toHaveBeenCalled();
        await settleTransitions();
      },
    );
  }

  it("shows a successful result as a status rather than another deploy button", async () => {
    context.feedback = {
      gameId: "stardewvalley",
      profileId: "p",
      requestId: "r",
      state: "deployed",
      changedAt: 1,
    };
    render(<GameActions />);
    const status = screen.getByRole("status", { name: "Mods deployed" });
    fireEvent.click(status);
    expect(context.deploy).not.toHaveBeenCalled();
    expect(context.emit).not.toHaveBeenCalled();
    await settleTransitions();
  });

  it("busy progress takes precedence over a retained failure", async () => {
    context.feedback = {
      gameId: "stardewvalley",
      profileId: "p",
      requestId: "r",
      state: "failed",
      changedAt: 1,
    };
    context.isDeploying = true;
    context.deployProgress = 42;
    render(<GameActions />);
    expect(screen.getByRole("progressbar", { name: "Applying" })).toHaveAttribute(
      "aria-valuenow",
      "42",
    );
    expect(screen.queryByRole("button", { name: "Deployment failed" })).toBeNull();
    await settleTransitions();
  });

  it("with auto deploy on, skips the clickable Apply and only shows it while deploying", async () => {
    context.autoDeploy = true;
    context.needToDeploy = true;
    const { rerender } = render(<GameActions />);

    expect(screen.queryByTestId("menu-apply")).toBeNull();
    expect(screen.getByText("Play")).toBeInTheDocument();

    context.isDeploying = true;
    context.deployProgress = 10;
    rerender(<GameActions />);

    expect(screen.getByRole("progressbar", { name: "Applying" })).toBeInTheDocument();

    await settleTransitions();
  });
});
