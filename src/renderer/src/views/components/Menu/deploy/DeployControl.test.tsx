import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  DeployStatus,
  IDeployMods,
} from "@/extensions/mod_management/hooks/useDeployMods.hook";

const context = vi.hoisted(() => ({
  design: undefined as number | undefined,
  deploy: {} as IDeployMods,
}));

vi.mock("react-redux", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useSelector: (selector: (state: unknown) => unknown) =>
    selector({ settings: { interface: { deployButtonStyle: context.design } } }),
}));

vi.mock("@/extensions/mod_management/hooks/useDeployMods.hook", () => ({
  useDeployMods: () => context.deploy,
}));

import { DEPLOY_DESIGNS, DeployControl } from "./DeployControl";

const deployFor = (status: DeployStatus): IDeployMods => ({
  deploy: vi.fn(),
  failure:
    status === "failed"
      ? { title: "Failed to deploy mods", content: { text: "disk on fire" } }
      : null,
  isDeploying: status === "deploying",
  isWaiting: false,
  needToDeploy: status !== "idle",
  progressText: undefined,
  showFailure: vi.fn(),
  status,
});

const play = (isCollapsed = false, disabled = false) => ({
  disabled,
  gameName: "Fallout 4",
  isCollapsed,
  isPrimaryRunning: false,
  primaryStarter: undefined,
  onClick: vi.fn(),
});

/**
 * The control the design gives the Deploy test id: its button, design 1's progress bar
 * while deploying, or Play's button for design 5.
 */
const control = () => {
  const marked = screen.getByTestId("deploy-mods");
  return marked.tagName === "BUTTON" || marked.tabIndex >= 0
    ? marked
    : marked.querySelector("button")!;
};

const STATUSES: DeployStatus[] = ["idle", "needed", "deploying", "failed"];

beforeEach(() => {
  context.design = undefined;
});

describe("DeployControl", () => {
  it("shows the NMA-style panel until another design is picked", () => {
    context.deploy = deployFor("idle");

    const { container } = render(<DeployControl play={play()} />);

    expect(container.querySelector("[data-deploy-design]")).toHaveAttribute(
      "data-deploy-design",
      "1",
    );
  });

  it("falls back to the default for a design that doesn't exist", () => {
    context.design = 42;
    context.deploy = deployFor("idle");

    const { container } = render(<DeployControl play={play()} />);

    expect(container.querySelector("[data-deploy-design]")).toHaveAttribute(
      "data-deploy-design",
      "1",
    );
  });

  it.each(DEPLOY_DESIGNS.map((design) => design.id))("switches to design %i", (id) => {
    context.design = id;
    context.deploy = deployFor("idle");

    const { container } = render(<DeployControl play={play()} />);

    expect(container.querySelector("[data-deploy-design]")).toHaveAttribute(
      "data-deploy-design",
      String(id),
    );
  });
});

describe.each(DEPLOY_DESIGNS.map((design) => [design.id, design.name] as const))(
  "design %i, %s",
  (id) => {
    beforeEach(() => {
      context.design = id;
    });

    it.each(STATUSES)("shows the %s state, expanded and collapsed", (status) => {
      context.deploy = deployFor(status);

      const { rerender } = render(<DeployControl play={play()} />);
      expect(screen.getByTestId("deploy-mods")).toHaveAttribute("data-deploy-state", status);

      rerender(<DeployControl play={play(true)} />);
      expect(screen.getByTestId("deploy-mods")).toHaveAttribute("data-deploy-state", status);
    });

    it("deploys when changes wait", () => {
      context.deploy = deployFor("needed");

      render(<DeployControl play={play()} />);
      fireEvent.click(control());

      expect(context.deploy.deploy).toHaveBeenCalledTimes(1);
      expect(context.deploy.showFailure).not.toHaveBeenCalled();
    });

    // A second click would only queue another deployment behind the running one.
    it("ignores clicks while deploying", () => {
      context.deploy = deployFor("deploying");

      render(<DeployControl play={play()} />);
      fireEvent.click(control());

      expect(context.deploy.deploy).not.toHaveBeenCalled();
    });

    it("says it is busy while deploying", () => {
      context.deploy = deployFor("deploying");

      render(<DeployControl play={play()} />);

      expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    });

    // The failure's notification is gone, so its details are here.
    it("opens the failure's details instead of deploying", () => {
      context.deploy = deployFor("failed");

      render(<DeployControl play={play()} />);
      fireEvent.click(control());

      expect(context.deploy.showFailure).toHaveBeenCalledTimes(1);
      expect(context.deploy.deploy).not.toHaveBeenCalled();
    });

    it("names the control when collapsed, where it has no text", () => {
      context.deploy = deployFor("needed");

      render(<DeployControl play={play(true)} />);

      expect(control()).toHaveAttribute("aria-label");
    });

    // Focus keeps the tooltip, which says why it is busy, in reach from the keyboard.
    it("stays focusable while deploying", () => {
      context.deploy = deployFor("deploying");

      render(<DeployControl play={play()} />);

      expect(control().tabIndex).toBeGreaterThanOrEqual(0);
      expect(control()).not.toBeDisabled();
    });

    it("names the control while deploying", () => {
      context.deploy = deployFor("deploying");

      render(<DeployControl play={play(true)} />);

      expect(control()).toHaveAttribute("aria-label");
    });
  },
);

describe.each([1, 3, 4])("design %i", (id) => {
  beforeEach(() => {
    context.design = id;
  });

  it.each([false, true])("puts Deploy above Play (collapsed: %s)", (collapsed) => {
    context.deploy = deployFor("needed");

    const { container } = render(<DeployControl play={play(collapsed)} />);

    const buttons = [...container.querySelectorAll("button")];
    const deploy = screen.getByTestId("deploy-mods");
    expect(buttons.at(-1)).not.toBe(deploy);
    expect(deploy.compareDocumentPosition(buttons.at(-1)!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });
});

describe("designs with a rocket", () => {
  it.each([2, 3, 4, 5])("design %i animates it only while deploying", (id) => {
    context.design = id;
    context.deploy = deployFor("deploying");

    const { container, rerender } = render(<DeployControl play={play(true)} />);
    expect(container.querySelector('[class*="animate-rocket"]')).not.toBeNull();

    context.deploy = deployFor("needed");
    rerender(<DeployControl play={play(true)} />);
    expect(container.querySelector('[class*="animate-rocket"]')).toBeNull();
  });
});

describe("design 5, merged into Play", () => {
  beforeEach(() => {
    context.design = 5;
  });

  it("is just Play when everything is deployed", () => {
    context.deploy = deployFor("idle");
    const playProps = play();

    render(<DeployControl play={playProps} />);
    fireEvent.click(control());

    expect(playProps.onClick).toHaveBeenCalledTimes(1);
    expect(context.deploy.deploy).not.toHaveBeenCalled();
  });

  it("deploys and then launches when changes wait", () => {
    context.deploy = deployFor("needed");
    const playProps = play();

    render(<DeployControl play={playProps} />);
    fireEvent.click(control());

    expect(context.deploy.deploy).toHaveBeenCalledWith(playProps.onClick);
  });

  it("only deploys when there's nothing to launch", () => {
    context.deploy = deployFor("needed");

    render(<DeployControl play={play(false, true)} />);
    fireEvent.click(control());

    expect(context.deploy.deploy).toHaveBeenCalledWith(undefined);
  });

  it("badges Play with the state when collapsed", () => {
    context.deploy = deployFor("failed");

    render(<DeployControl play={play(true)} />);

    expect(control()).toHaveAttribute("data-play-badge", "danger");
  });
});

describe("design 1, NMA's Apply panel", () => {
  beforeEach(() => {
    context.design = 1;
  });

  // NMA shows Apply only while there is something to apply.
  it("leaves just Play when everything is deployed", () => {
    context.deploy = deployFor("idle");

    const { container } = render(<DeployControl play={play()} />);

    expect(container.querySelectorAll("button")).toHaveLength(1);
  });

  it("shows the running job's status on the progress bar", () => {
    context.deploy = { ...deployFor("deploying"), progressText: "Deploying: Some Mod" };

    render(<DeployControl play={play()} />);

    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuetext",
      "Deploying: Some Mod",
    );
  });

  // As NMA disables Launch while it applies.
  it("disables Play while deploying", () => {
    context.deploy = deployFor("deploying");

    const { container } = render(<DeployControl play={play()} />);

    expect([...container.querySelectorAll("button")].at(-1)).toBeDisabled();
  });

  // NMA's "Processing changes..." row, for a deployment still waiting to start.
  it("shows the processing row while a deployment waits", () => {
    context.deploy = {
      ...deployFor("deploying"),
      isDeploying: false,
      isWaiting: true,
      progressText: "Waiting for other operations to complete",
    };

    render(<DeployControl play={play()} />);

    expect(screen.getByRole("status")).toHaveAttribute("data-testid", "deploy-mods");
    expect(screen.queryByRole("progressbar")).toBeNull();
  });
});
