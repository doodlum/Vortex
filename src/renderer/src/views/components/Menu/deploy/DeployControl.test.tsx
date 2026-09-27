import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  DeployStatus,
  IDeployMods,
} from "@/extensions/mod_management/hooks/useDeployMods.hook";

const context = vi.hoisted(() => ({
  design: undefined as number | undefined,
  gate: undefined as number | undefined,
  deploy: {} as IDeployMods,
}));

vi.mock("react-redux", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useSelector: (selector: (state: unknown) => unknown) =>
    selector({
      settings: {
        interface: { deployButtonStyle: context.design, playWhilePending: context.gate },
      },
    }),
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
  context.gate = undefined;
});

describe("DeployControl", () => {
  it("offers four status row variations", () => {
    expect(IDS).toEqual([6, 7, 10, 11]);
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
  it.each([1, 2, 3, 4, 5, 8, 9, 42])("shows Dot for removed design %i", (removed) => {
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

    // Short labels on the row and in its tooltip; the notifications' full wording is in
    // the dialogs behind More and a failure (asserted in useDeployMods.hook.test.tsx).
    // There is no i18n instance in tests, so `t` returns these keys - the strings.
    describe("says it briefly", () => {
      it.each([
        ["idle", "Up to date"],
        ["needed", "Apply changes"],
        ["deployed", "Changes applied"],
        ["failed", "Couldn't apply"],
      ] as const)("%s: %s, on the row itself", (status, text) => {
        context.deploy = deployFor(status);

        render(<DeployControl play={play()} />);

        expect(control()).toHaveTextContent(text);
      });

      it.each([false, true])("names the collapsed row the same (collapsed: %s)", (collapsed) => {
        context.deploy = deployFor("needed");

        render(<DeployControl play={play(collapsed)} />);

        expect(said()).toContain("Apply changes");
      });

      it("Applying... with the percent, and the step in the tooltip", () => {
        context.deploy = {
          ...deployFor("deploying"),
          progressText: "Deploying: Some Mod",
          progressPercent: 42,
        };

        render(<DeployControl play={play()} />);

        expect(control()).toHaveTextContent("Applying... 42%");
        expect(said()).toContain("Deploying: Some Mod");
      });

      it("Waiting... while it waits to start", () => {
        context.deploy = {
          ...deployFor("deploying"),
          isDeploying: false,
          isWaiting: true,
          progressText: "Waiting for other operations to complete",
        };

        render(<DeployControl play={play()} />);

        expect(control()).toHaveTextContent("Waiting...");
        expect(said()).toContain("Waiting for other operations to complete");
      });

      it("one short sentence in the tooltip when changes wait", () => {
        context.deploy = deployFor("needed");

        render(<DeployControl play={play()} />);

        expect(said()).toContain("Mods changed since the last deploy.");
        // the paragraph is for the More dialog, not the tooltip
        expect(said()).not.toContain("Recent changes to the active mods");
      });

      it("the failure's headline in the tooltip", () => {
        context.deploy = deployFor("failed");

        render(<DeployControl play={play()} />);

        expect(said()).toContain("Failed to deploy mods");
      });

      // More leads to the original "Deployment necessary" dialog, with its checkbox.
      it("offers More", () => {
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

/** Play: the last button outside a tooltip. */
const playButton = (container: HTMLElement) =>
  [...container.querySelectorAll("button")]
    .filter((button) => !button.closest('[data-testid="tooltip"]'))
    .at(-1)!;

const PENDING: DeployStatus[] = ["needed", "deploying", "failed"];

// Every row with every gate: 3 x 3.
describe.each(IDS.flatMap((design) => [1, 2, 3].map((gate) => [design, gate] as const)))(
  "row %i with Play gate %i",
  (design, gate) => {
    beforeEach(() => {
      context.design = design;
      context.gate = gate;
    });

    it.each(PENDING)("never launches the game while %s", (status) => {
      context.deploy = deployFor(status);
      const playProps = play();

      const { container } = render(<DeployControl play={playProps} />);
      fireEvent.click(playButton(container));

      expect(playProps.onClick).not.toHaveBeenCalled();
    });

    it.each([false, true])(
      "says why Play is held back, to screen readers too (collapsed: %s)",
      (collapsed) => {
        context.deploy = deployFor("needed");

        const { container } = render(<DeployControl play={play(collapsed)} />);

        // Apply first names what it will do: apply, then play
        expect(playButton(container).getAttribute("aria-label")).toMatch(
          gate === 3 ? /^Apply & play$/ : /Apply changes first/,
        );
      },
    );

    it("plays as always when nothing is pending", () => {
      context.deploy = deployFor("idle");
      const playProps = play();

      const { container } = render(<DeployControl play={playProps} />);
      fireEvent.click(playButton(container));

      expect(playProps.onClick).toHaveBeenCalledTimes(1);
      expect(playButton(container)).not.toHaveAttribute("data-play-gate");
    });

    // Refused for a running tool, with nothing to deploy: not pending.
    it("plays after a failure with nothing pending", () => {
      context.deploy = { ...deployFor("failed"), needToDeploy: false };
      const playProps = play();

      const { container } = render(<DeployControl play={playProps} />);
      fireEvent.click(playButton(container));

      expect(playProps.onClick).toHaveBeenCalledTimes(1);
    });

    it("keeps Play focusable while it is held back", () => {
      context.deploy = deployFor("needed");

      const { container } = render(<DeployControl play={play()} />);

      expect(playButton(container)).not.toBeDisabled();
    });
  },
);

describe("gate 1, Disabled", () => {
  beforeEach(() => {
    context.gate = 1;
  });

  it.each(PENDING)("marks Play unavailable while %s", (status) => {
    context.deploy = deployFor(status);

    const { container } = render(<DeployControl play={play()} />);

    expect(playButton(container)).toHaveAttribute("aria-disabled", "true");
    expect(context.deploy.deploy).not.toHaveBeenCalled();
  });
});

describe("gate 2, Locked by the row", () => {
  beforeEach(() => {
    context.gate = 2;
  });

  it("sends focus to the row, and draws attention to it", () => {
    context.deploy = deployFor("needed");

    const { container } = render(<DeployControl play={play()} />);
    fireEvent.click(playButton(container));

    expect(document.activeElement).toBe(control());
    expect(container.querySelector("[data-attention]")).not.toBeNull();
    expect(context.deploy.deploy).not.toHaveBeenCalled();
  });

  it("wears the pending state's name", () => {
    context.deploy = deployFor("needed");

    const { container } = render(<DeployControl play={play()} />);

    expect(playButton(container)).toHaveTextContent("Apply changes first");
  });
});

describe("gate 3, Apply first", () => {
  beforeEach(() => {
    context.gate = 3;
  });

  it("deploys, and launches only once that completes", () => {
    context.deploy = deployFor("needed");
    const playProps = play();

    const { container } = render(<DeployControl play={playProps} />);
    fireEvent.click(playButton(container));

    expect(context.deploy.deploy).toHaveBeenCalledWith(playProps.onClick);
    expect(playProps.onClick).not.toHaveBeenCalled();
    expect(playButton(container)).toHaveTextContent("Apply & play");
  });

  it("retries the deployment after a failure, then launches", () => {
    context.deploy = deployFor("failed");
    const playProps = play();

    const { container } = render(<DeployControl play={playProps} />);
    fireEvent.click(playButton(container));

    expect(context.deploy.deploy).toHaveBeenCalledWith(playProps.onClick);
  });

  it("is unavailable while the deployment runs", () => {
    context.deploy = deployFor("deploying");

    const { container } = render(<DeployControl play={play()} />);
    fireEvent.click(playButton(container));

    expect(playButton(container)).toHaveAttribute("aria-disabled", "true");
    expect(context.deploy.deploy).not.toHaveBeenCalled();
  });
});
