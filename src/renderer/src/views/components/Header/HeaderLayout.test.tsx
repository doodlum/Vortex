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
vi.mock("../panels/PanelToolbar", () => ({
  PanelToolbar: () => <div data-testid="panel-toolbar" />,
}));

import { Header } from "./Header";

describe("Header layout", () => {
  it("puts the panel toolbar before the profile menu, and the version beside the window controls", () => {
    render(<Header />);
    const order = ["panel-toolbar", "profile", "premium", "staging", "version", "window-controls"];
    const nodes = order.map((id) => screen.getByTestId(id));
    for (let i = 1; i < nodes.length; i++) {
      expect(
        nodes[i - 1]!.compareDocumentPosition(nodes[i]!) & Node.DOCUMENT_POSITION_FOLLOWING,
        `${order[i - 1]} comes before ${order[i]}`,
      ).toBeTruthy();
    }
  });
});
