import { render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/contexts", () => ({
  useWindowContext: () => ({ menuIsCollapsed: false, setMenuIsCollapsed: vi.fn() }),
}));
vi.mock("../Spine/SpineContext", () => ({
  useSpineContext: () => ({ selection: { type: "home" } }),
}));
vi.mock("../../../util/selectors", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  activeProfile: () => undefined,
  gameProfiles: () => [],
  knownGames: () => [],
}));
vi.mock("react-redux", () => ({
  useSelector: (selector: (state: unknown) => unknown) => selector({}),
}));
vi.mock("./premium/PremiumIndicator", () => ({
  PremiumIndicator: () => <div data-testid="premium" />,
}));
vi.mock("./profile/ProfileSection", () => ({
  ProfileSection: () => <div data-testid="profile" />,
}));
vi.mock("./StagingIndicator", () => ({
  StagingIndicator: () => <div data-testid="staging" />,
}));
vi.mock("./VersionIndicator", () => ({
  VersionIndicator: () => <div data-testid="version" />,
}));
vi.mock("./WindowControls", () => ({
  WindowControls: () => <div data-testid="window-controls" />,
}));

import { Header } from "./Header";

describe("Header layout", () => {
  it("leads with the profile menu and keeps the version beside the window controls", () => {
    render(<Header />);
    const order = ["profile", "premium", "staging", "version", "window-controls"];
    const nodes = order.map((id) => screen.getByTestId(id));
    for (let i = 1; i < nodes.length; i++) {
      expect(
        nodes[i - 1]!.compareDocumentPosition(nodes[i]!) & Node.DOCUMENT_POSITION_FOLLOWING,
        `${order[i - 1]} comes before ${order[i]}`,
      ).toBeTruthy();
    }
  });

  it("spaces the version, divider and window controls as one group, apart from the rest", () => {
    render(<Header />);
    const version = screen.getByTestId("version");
    const group = version.parentElement!;
    const divider = version.nextElementSibling!;

    expect(group).toHaveClass("gap-x-5");
    expect(divider).toHaveClass("h-6", "w-0.5", "rounded-md", "bg-stroke-weak");
    expect(divider.nextElementSibling).toBe(screen.getByTestId("window-controls"));

    const cluster = group.parentElement!;
    expect(cluster).toHaveClass("gap-x-2");
    for (const id of ["profile", "premium", "staging"]) {
      expect(screen.getByTestId(id).parentElement, id).toBe(cluster);
    }
  });
  it("keeps the title flexible and the controls outside the draggable region", () => {
    render(<Header />);
    const bar = screen.getByTestId("window-titlebar");
    expect(bar).toHaveClass(
      "h-11",
      "shrink-0",
      "[-webkit-app-region:drag]",
      "has-aria-expanded:[-webkit-app-region:no-drag]",
    );
    expect(bar.style.zoom).toBe("");
    expect(bar.firstElementChild).toHaveClass("min-w-0", "flex-1");
    const cluster = bar.lastElementChild!;
    expect(cluster).toHaveClass("shrink-0", "[-webkit-app-region:no-drag]");
    expect(cluster.parentElement).toBe(bar);
    expect(screen.getByRole("button", { name: "Collapse menu" })).toHaveClass(
      "[-webkit-app-region:no-drag]",
    );
  });
});
