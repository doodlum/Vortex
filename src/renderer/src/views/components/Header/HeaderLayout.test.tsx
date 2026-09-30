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

  it("centers the version between columns that share the free space, with no divider", () => {
    const { container } = render(<Header />);
    const bar = container.firstElementChild!;
    const version = screen.getByTestId("version");

    // Exactly these classes: padding, a border or a margin on the bar would move its middle off
    // the bar's center. The right column is at least as wide as its controls' natural width, so
    // when they need more than half the bar the version moves aside instead of squeezing them or
    // ending up under them.
    expect(bar.className.split(/\s+/).sort()).toEqual(
      [
        "gap-x-6",
        "grid",
        "grid-cols-[minmax(0,1fr)_auto_minmax(max-content,1fr)]",
        "h-11",
        "items-center",
      ].sort(),
    );
    expect([...bar.children].indexOf(version)).toBe(1);
    expect(bar.children).toHaveLength(3);
    expect(container.querySelector(".bg-stroke-weak")).toBeNull();

    const classes = (element: Element) => element.className.split(/\s+/).sort();
    // The left column carries the bar's inset, so the menu toggle stays where it was.
    expect(classes(bar.firstElementChild!)).toEqual(
      ["flex", "gap-x-1", "items-center", "min-w-0", "pl-4.5"].sort(),
    );
    // Padding, a margin or a width on the cluster would move the window controls.
    const cluster = bar.lastElementChild!;
    expect(classes(cluster)).toEqual(
      ["flex", "gap-x-5", "items-center", "justify-self-end"].sort(),
    );
    const controls = screen.getByTestId("profile").parentElement!;
    expect(classes(controls)).toEqual(["flex", "gap-x-2", "items-center"].sort());
    for (const id of ["premium", "staging"]) {
      expect(screen.getByTestId(id).parentElement, id).toBe(controls);
    }
    expect([...cluster.children]).toEqual([controls, screen.getByTestId("window-controls")]);
    // The drag regions (the bar drags, the cluster doesn't) aren't checked here: happy-dom drops
    // -webkit-app-region. Check them in the app.
  });
});
