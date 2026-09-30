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
  it("leads with the profile menu and ends with the window controls", () => {
    render(<Header />);
    const order = ["profile", "premium", "staging", "window-controls"];
    const nodes = order.map((id) => screen.getByTestId(id));
    for (let i = 1; i < nodes.length; i++) {
      expect(
        nodes[i - 1]!.compareDocumentPosition(nodes[i]!) & Node.DOCUMENT_POSITION_FOLLOWING,
        `${order[i - 1]} comes before ${order[i]}`,
      ).toBeTruthy();
    }
  });

  it("centers the version between two equal columns, with no divider", () => {
    const { container } = render(<Header />);
    const bar = container.firstElementChild!;
    const version = screen.getByTestId("version");

    // The middle of three columns whose sides share the free space equally stays centered.
    expect(bar).toHaveClass("grid", "grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]");
    // Side padding on the grid would shift its middle off the bar's center.
    expect(bar.className).not.toMatch(/\bp[lrx]-/);
    expect([...bar.children].indexOf(version)).toBe(1);
    expect(bar.children).toHaveLength(3);
    expect(container.querySelector(".bg-stroke-weak")).toBeNull();

    const cluster = bar.lastElementChild!;
    expect(cluster).toHaveClass("justify-self-end", "gap-x-5");
    const controls = screen.getByTestId("profile").parentElement!;
    expect(controls).toHaveClass("gap-x-2");
    for (const id of ["premium", "staging"]) {
      expect(screen.getByTestId(id).parentElement, id).toBe(controls);
    }
    expect([...cluster.children]).toEqual([controls, screen.getByTestId("window-controls")]);
  });
});
