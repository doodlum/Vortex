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
  clearDeploymentFailures,
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
        session: {
          mods: { deploymentFailure: { fallout4: failure, skyrimse: null } },
          extensions: { available: [] },
        },
      }),
      getLoadedExtensions: () => [],
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

  it("keeps what the dialog needs to offer: the fix, and a passing cause", () => {
    const { api, dispatch } = apiFor(true);

    reportDeploymentFailure(
      api,
      "fallout4",
      { title: "Can't deploy", fix: "deployment-method", cause: "tools-running" },
      vi.fn(),
    );

    const failure = reduce(dispatch.mock.calls[0][0]).deploymentFailure.fallout4;
    expect(failure.fix).toBe("deployment-method");
    expect(failure.cause).toBe("tools-running");
  });

  // What api.showErrorNotification would have added: Report goes to the extension's
  // tracker, and the text says whom to report it to.
  it("finds the extension an error names, as showErrorNotification does", () => {
    const { api, dispatch } = apiFor(true);
    const extension = {
      name: "some-extension",
      info: {
        name: "Some Extension",
        author: "someone",
        issueTrackerURL: "https://example.invalid",
      },
    };
    Object.assign(api as object, { getLoadedExtensions: () => [extension] });
    const err = Object.assign(new Error("broke"), { extension: "some-extension" });

    reportDeploymentFailure(
      api,
      "fallout4",
      { title: "Failed to deploy mods", details: err },
      vi.fn(),
    );

    const failure = reduce(dispatch.mock.calls[0][0]).deploymentFailure.fallout4;
    expect(failure.reportURL).toBe("https://example.invalid");
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

describe("clearDeploymentFailures", () => {
  // "Can't deploy while the game or a tool is running" stops being true when they exit.
  it("clears the failures a passing cause left", () => {
    const { api, dispatch } = apiFor(true, { title: "Can't deploy", cause: "tools-running" });

    clearDeploymentFailures(api, "tools-running");

    expect(reduce(dispatch.mock.calls[0][0]).deploymentFailure.fallout4).toBeNull();
  });

  it("leaves other failures until a deployment succeeds", () => {
    const { api, dispatch } = apiFor(true, { title: "Failed to deploy mods" });

    clearDeploymentFailures(api, "tools-running");

    expect(dispatch).not.toHaveBeenCalled();
  });
});
