import { describe, expect, it, vi } from "vitest";

import { UserCanceled } from "../../util/CustomErrors";
import preStartDeployHook from "./preStartDeployHook";

/**
 * A pre-launch deploy the user said yes to, whose handler reports a failure and calls back
 * without an error - as it does - leaving the changes undeployed.
 */
const apiFor = (useModernLayout: boolean, stillPending: boolean) => {
  let deployed = false;
  const state = () => ({
    settings: { window: { useModernLayout } },
    session: { base: {} },
    persistent: {
      profiles: { a: { id: "a", gameId: "fallout4" } },
      deployment: { needToDeploy: { fallout4: !deployed || stillPending } },
    },
  });
  return {
    getState: state,
    store: { getState: state },
    translate: (text: string) => text,
    showDialog: vi.fn(() => Promise.resolve({ action: "Deploy", input: {} })),
    events: {
      emit: vi.fn((_event: string, callback: (err: Error | null) => void) => {
        deployed = true;
        callback(null);
      }),
    },
  } as never;
};

vi.mock("./selectors", () => ({
  needToDeploy: (state: { persistent: { deployment: { needToDeploy: { fallout4: boolean } } } }) =>
    state.persistent.deployment.needToDeploy.fallout4,
}));

const input = { options: { suggestDeploy: true } } as never;

describe("preStartDeployHook", () => {
  it("launches after a deployment that completed", async () => {
    await expect(preStartDeployHook(apiFor(true, false), input)).resolves.toBe(input);
  });

  // The Deploy control shows the failure; the game mustn't start past it.
  it("stops the launch when the deployment left the changes undeployed", async () => {
    await expect(preStartDeployHook(apiFor(true, true), input)).rejects.toBeInstanceOf(
      UserCanceled,
    );
  });

  // Where it notified, as master does.
  it("launches as before in the classic layout", async () => {
    await expect(preStartDeployHook(apiFor(false, true), input)).resolves.toBe(input);
  });
});
