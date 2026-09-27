import { describe, expect, it, vi } from "vitest";

vi.mock("../../../util/errorHandling", () => ({
  didIgnoreError: () => false,
  isOutdated: () => false,
  recordErrorSpan: vi.fn(),
}));

vi.mock("../../../util/log", () => ({ log: vi.fn() }));

import { sessionReducer } from "../reducers/session";
import {
  clearDeploymentFailure,
  deploysWithoutNotifications,
  reportDeploymentFailure,
} from "./deploymentFailure";

const apiFor = (useModernLayout: boolean | undefined, failure: unknown = null) => {
  const dispatch = vi.fn();
  return {
    dispatch,
    api: {
      getState: () => ({
        settings: { window: { useModernLayout } },
        session: { mods: { deploymentFailure: { fallout4: failure } } },
      }),
      store: { dispatch },
    } as never,
  };
};

const reduce = (action: { type: string; payload: unknown }) =>
  sessionReducer.reducers[action.type](sessionReducer.defaults, action.payload);

describe("deploysWithoutNotifications", () => {
  it("is the modern layout, which is the default", () => {
    expect(deploysWithoutNotifications({ settings: { window: {} } } as never)).toBe(true);
    expect(
      deploysWithoutNotifications({ settings: { window: { useModernLayout: false } } } as never),
    ).toBe(false);
  });
});

describe("reportDeploymentFailure", () => {
  it("raises the notification it always did in the classic layout", () => {
    const { api, dispatch } = apiFor(false);
    const notify = vi.fn();

    reportDeploymentFailure(api, "fallout4", { title: "Failed to deploy mods" }, notify);

    expect(notify).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("keeps the failure for the Deploy control instead in the modern layout", () => {
    const { api, dispatch } = apiFor(true);
    const notify = vi.fn();

    reportDeploymentFailure(
      api,
      "fallout4",
      { title: "Failed to deploy mods", details: new Error("disk on fire") },
      notify,
    );

    expect(notify).not.toHaveBeenCalled();
    const state = reduce(dispatch.mock.calls[0][0]);
    expect(state.deploymentFailure.fallout4).toMatchObject({
      title: "Failed to deploy mods",
      content: { message: expect.stringContaining("disk on fire") },
    });
  });

  // It has to survive being kept in the store and read back.
  it("keeps plain data", () => {
    const { api, dispatch } = apiFor(true);

    reportDeploymentFailure(
      api,
      "fallout4",
      { title: "Failed to deploy mods", details: new Error("disk on fire") },
      vi.fn(),
    );

    const failure = reduce(dispatch.mock.calls[0][0]).deploymentFailure.fallout4;
    expect(JSON.parse(JSON.stringify(failure))).toEqual(failure);
  });

  it("uses the title as the details when there are none", () => {
    const { api, dispatch } = apiFor(true);

    reportDeploymentFailure(
      api,
      "fallout4",
      { title: "Can't deploy while the game or a tool is running", warning: true },
      vi.fn(),
    );

    const failure = reduce(dispatch.mock.calls[0][0]).deploymentFailure.fallout4;
    expect(failure.content.text).toBe("Can't deploy while the game or a tool is running");
    expect(failure.warning).toBe(true);
  });

  it("keeps what the dialog needs to offer: the cycles, the fix", () => {
    const { api, dispatch } = apiFor(true);

    reportDeploymentFailure(
      api,
      "fallout4",
      { title: "Mod rules contain cycles", cycles: [["a", "b"]], fix: "deployment-method" },
      vi.fn(),
    );

    const failure = reduce(dispatch.mock.calls[0][0]).deploymentFailure.fallout4;
    expect(failure.cycles).toEqual([["a", "b"]]);
    expect(failure.fix).toBe("deployment-method");
  });

  // Nowhere to show it without a game, so the notification it always was.
  it("notifies when there's no game to keep it for", () => {
    const { api, dispatch } = apiFor(true);
    const notify = vi.fn();

    reportDeploymentFailure(api, undefined, { title: "Failed to deploy mods" }, notify);

    expect(notify).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe("clearDeploymentFailure", () => {
  it("clears a failure the control shows", () => {
    const { api, dispatch } = apiFor(true, { title: "Failed to deploy mods" });

    clearDeploymentFailure(api, "fallout4");

    expect(reduce(dispatch.mock.calls[0][0]).deploymentFailure.fallout4).toBeNull();
  });

  it("dispatches nothing when there is none", () => {
    const { api, dispatch } = apiFor(true);

    clearDeploymentFailure(api, "fallout4");

    expect(dispatch).not.toHaveBeenCalled();
  });
});
