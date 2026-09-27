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

// Tooltips drawn in place, so a test can read what each variation's tooltip says.
vi.mock("@/ui/components/tooltip/Tooltip", () => ({
  Tooltip: ({
    children,
    content,
    customContent,
  }: {
    children: React.ReactNode;
    content?: string;
    customContent?: React.ReactNode;
  }) => (
    <>
      {children}
      <div data-testid="tooltip">{customContent ?? content}</div>
    </>
  ),
}));

import { DEPLOY_DESIGNS, DeployControl } from "./DeployControl";

const deployFor = (status: DeployStatus): IDeployMods => ({
  autoDeploy: false,
  deploy: vi.fn(),
  failure:
    status === "failed"
      ? { title: "Failed to deploy mods", content: { text: "disk on fire" } }
      : null,
  isDeploying: status === "deploying",
  isWaiting: false,
  needToDeploy: status === "needed" || status === "deploying" || status === "failed",
  progressPercent: undefined,
  progressText: undefined,
  showFailure: vi.fn(),
  showNecessary: vi.fn(),
  status,
});

const play = (isCollapsed = false) => ({
  disabled: false,
  gameName: "Fallout 4",
  isCollapsed,
  isPrimaryRunning: false,
  primaryStarter: undefined,
  onClick: vi.fn(),
});

const control = () => screen.getByTestId("deploy-mods");

/** Everything the variation shows and its tooltips say, together. */
const said = () => document.body.textContent ?? "";

const STATUSES: DeployStatus[] = ["idle", "deployed", "needed", "deploying", "failed"];
const IDS = DEPLOY_DESIGNS.map((design) => design.id);

beforeEach(() => {
  context.design = undefined;
});

describe("DeployControl", () => {
  it("offers five status row variations", () => {
    expect(IDS).toEqual([6, 7, 8, 9, 10]);
  });

  it("shows the first variation until another is picked", () => {
    context.deploy = deployFor("idle");

    const { container } = render(<DeployControl play={play()} />);

    expect(container.querySelector("[data-deploy-design]")).toHaveAttribute(
      "data-deploy-design",
      "6",
    );
  });

  // 1 to 5 were the earlier designs; a stored one reads as the first variation.
  it.each([1, 2, 3, 4, 5, 42])("shows the first variation for removed design %i", (removed) => {
    context.design = removed;
    context.deploy = deployFor("idle");

    const { container } = render(<DeployControl play={play()} />);

    expect(container.querySelector("[data-deploy-design]")).toHaveAttribute(
      "data-deploy-design",
      "6",
    );
  });

  it.each(IDS)("switches to variation %i", (id) => {
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
  "variation %i, %s",
  (id) => {
    beforeEach(() => {
      context.design = id;
    });

    it.each(STATUSES)("shows the %s state, expanded and collapsed", (status) => {
      context.deploy = deployFor(status);

      const { rerender } = render(<DeployControl play={play()} />);
      expect(control()).toHaveAttribute("data-deploy-state", status);

      rerender(<DeployControl play={play(true)} />);
      expect(control()).toHaveAttribute("data-deploy-state", status);
    });

    it.each([false, true])("sits directly above Play (collapsed: %s)", (collapsed) => {
      context.deploy = deployFor("needed");

      const { container } = render(<DeployControl play={play(collapsed)} />);

      const buttons = [...container.querySelectorAll("button")].filter(
        (button) => !button.closest('[data-testid="tooltip"]'),
      );
      expect(buttons).toHaveLength(2);
      expect(buttons[0]).toBe(control());
    });

    it("deploys when changes wait", () => {
      context.deploy = deployFor("needed");

      render(<DeployControl play={play()} />);
      fireEvent.click(control());

      expect(context.deploy.deploy).toHaveBeenCalledTimes(1);
    });

    // A second click would only queue another deployment behind the running one.
    it("ignores clicks while deploying, and says it is busy", () => {
      context.deploy = deployFor("deploying");

      render(<DeployControl play={play()} />);
      fireEvent.click(control());

      expect(context.deploy.deploy).not.toHaveBeenCalled();
      expect(control()).toHaveAttribute("aria-busy", "true");
      expect(control()).not.toBeDisabled();
    });

    // The failure's notification is gone, so its details are here.
    it("opens the failure's details instead of deploying", () => {
      context.deploy = deployFor("failed");

      render(<DeployControl play={play()} />);
      fireEvent.click(control());

      expect(context.deploy.showFailure).toHaveBeenCalledTimes(1);
      expect(context.deploy.deploy).not.toHaveBeenCalled();
    });

    it.each(STATUSES)("names the collapsed control in the %s state", (status) => {
      context.deploy = deployFor(status);

      render(<DeployControl play={play(true)} />);

      expect(control()).toHaveAttribute("aria-label");
    });

    // The deploy notifications' own strings, which the row says in their place. There is
    // no i18n instance in tests, so `t` returns these keys - the source strings themselves.
    describe("keeps the notifications' messages", () => {
      it.each([false, true])("Deployment necessary (collapsed: %s)", (collapsed) => {
        context.deploy = deployFor("needed");

        render(<DeployControl play={play(collapsed)} />);

        expect(said()).toContain("Deployment necessary");
        expect(said()).toContain(
          "Recent changes to the active mods are currently pending, " +
            "a deployment must be run to apply the latest changes to your game.",
        );
      });

      it("its More, which opens the automatic deployment offer", () => {
        context.deploy = deployFor("needed");

        render(<DeployControl play={play()} />);
        fireEvent.click(screen.getByRole("button", { name: "More" }));

        expect(context.deploy.showNecessary).toHaveBeenCalledTimes(1);
      });

      it("no More while deployment is automatic, as the notification had none", () => {
        context.deploy = { ...deployFor("needed"), autoDeploy: true };

        render(<DeployControl play={play()} />);

        expect(screen.queryByRole("button", { name: "More" })).toBeNull();
      });

      it.each([false, true])("Deploying, its step and percent (collapsed: %s)", (collapsed) => {
        context.deploy = {
          ...deployFor("deploying"),
          progressText: "Deploying: Some Mod",
          progressPercent: 42,
        };

        render(<DeployControl play={play(collapsed)} />);

        expect(said()).toContain("Deploying");
        expect(said()).toContain("Deploying mods");
        expect(said()).toContain("Deploying: Some Mod");
        expect(said()).toContain("42%");
      });

      it("Waiting for other operations to complete", () => {
        context.deploy = {
          ...deployFor("deploying"),
          isDeploying: false,
          isWaiting: true,
          progressText: "Waiting for other operations to complete",
        };

        render(<DeployControl play={play()} />);

        expect(said()).toContain("Waiting for other operations to complete");
      });

      it.each([false, true])("Mods deployed (collapsed: %s)", (collapsed) => {
        context.deploy = deployFor("deployed");

        render(<DeployControl play={play(collapsed)} />);

        expect(said()).toContain("Mods deployed");
      });

      it.each([false, true])("the failure's headline (collapsed: %s)", (collapsed) => {
        context.deploy = deployFor("failed");

        render(<DeployControl play={play(collapsed)} />);

        expect(said()).toContain("Failed to deploy mods");
      });
    });

    // Expanded, the row itself says the state, not only its tooltip.
    it.each([
      ["needed", "Deployment necessary"],
      ["deployed", "Mods deployed"],
      ["failed", "Failed to deploy mods"],
    ] as const)("says %s on the row itself", (status, text) => {
      context.deploy = deployFor(status);

      render(<DeployControl play={play()} />);

      expect(control()).toHaveTextContent(text);
    });

    it("shows the running percent on the row itself", () => {
      context.deploy = {
        ...deployFor("deploying"),
        progressText: "Deploying: Some Mod",
        progressPercent: 42,
      };

      render(<DeployControl play={play()} />);

      expect(control()).toHaveTextContent("42%");
    });
  },
);

describe("variation 6, Dot, animates its rocket only while deploying", () => {
  it("does", () => {
    context.design = 6;
    context.deploy = deployFor("deploying");

    const { container, rerender } = render(<DeployControl play={play(true)} />);
    expect(container.querySelector(".animate-rocket-lift")).not.toBeNull();

    context.deploy = deployFor("needed");
    rerender(<DeployControl play={play(true)} />);
    expect(container.querySelector(".animate-rocket-lift")).toBeNull();
  });
});

describe("variation 8, Progress line", () => {
  beforeEach(() => {
    context.design = 8;
  });

  it("slides until the deployment gives a percent", () => {
    context.deploy = deployFor("deploying");

    const { container } = render(<DeployControl play={play()} />);

    expect(container.querySelector(".animate-deploy-progress")).not.toBeNull();
  });

  it("fills to the percent once it does", () => {
    context.deploy = { ...deployFor("deploying"), progressPercent: 42 };

    const { container } = render(<DeployControl play={play()} />);

    expect(container.querySelector(".animate-deploy-progress")).toBeNull();
    expect(container.querySelector('[style*="--deploy-progress: 42%"]')).not.toBeNull();
  });

  it("keeps the line under the icon when collapsed", () => {
    context.deploy = deployFor("deploying");

    const { container } = render(<DeployControl play={play(true)} />);

    expect(control().querySelector(".animate-deploy-progress")).not.toBeNull();
    expect(container).toBeTruthy();
  });
});
