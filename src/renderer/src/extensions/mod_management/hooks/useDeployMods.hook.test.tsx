import { act, renderHook } from "@testing-library/react";
import React, { type ReactNode } from "react";
import { Provider } from "react-redux";
import { createStore, type Store } from "redux";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { UserCanceled } from "@/util/CustomErrors";

import { sessionReducer } from "../reducers/session";
import type { IDeploymentFailure } from "../util/deploymentFailure";
import { NoDeployment } from "../util/exceptions";

vi.mock("@/util/errorHandling", () => ({
  didIgnoreError: () => false,
  isOutdated: () => false,
  recordErrorSpan: vi.fn(),
}));

const api = vi.hoisted(() => ({
  events: { emit: vi.fn() },
  sendNotification: vi.fn(),
  showErrorNotification: vi.fn(),
  showDialog: vi.fn(() => Promise.resolve({ action: "Close", input: {} })),
  getState: vi.fn(),
  store: undefined as unknown as Store,
}));

vi.mock("@/contexts", () => ({
  useMainContext: () => ({ api }),
}));

vi.mock("../util/deploymentMethods", () => ({
  getAllActivators: () => [{ id: "hardlink_activator" }],
}));

import { DEPLOYED_DISPLAY_MS, deployStatus, useDeployMods } from "./useDeployMods.hook";

interface IFixture {
  activator?: string;
  activity?: string[];
  needToDeploy?: boolean;
  failure?: IDeploymentFailure | null;
  progress?: { text: string; percent: number };
  useModernLayout?: boolean;
}

/** Just the slices the hook and the failure reporter read, for a Fallout 4 profile. */
const stateFor = ({
  activator = "hardlink_activator",
  activity = [],
  needToDeploy,
  failure = null,
  progress,
  useModernLayout = true,
}: IFixture) => ({
  settings: {
    mods: { activator: { fallout4: activator } },
    profiles: { activeProfileId: "profile-a", lastActiveProfile: { fallout4: "profile-a" } },
    window: { useModernLayout },
    automation: { deploy: false },
  },
  persistent: {
    profiles: { "profile-a": { id: "profile-a", gameId: "fallout4" } },
    deployment: { needToDeploy: { fallout4: needToDeploy } },
  },
  session: {
    base: {
      activity: { mods: activity },
      progress: progress === undefined ? {} : { deployment: { fallout4: progress } },
    },
    mods: { ...sessionReducer.defaults, deploymentFailure: { fallout4: failure } },
  },
});

const REPLACE = "TEST_REPLACE_STATE";

type TestState = ReturnType<typeof stateFor>;

/** The fixture, plus the real session reducer for the failures the hook reports. */
const reducer = (
  state: TestState,
  action: { type: string; state?: TestState; payload?: never },
) => {
  if (action.type === REPLACE) {
    return action.state!;
  }
  const handler = sessionReducer.reducers[action.type];
  return handler === undefined
    ? state
    : {
        ...state,
        session: { ...state.session, mods: handler(state.session.mods, action.payload) },
      };
};

const render = (fixture: IFixture = {}) => {
  const store = createStore(reducer as never, stateFor(fixture) as never) as Store;
  api.store = store;
  api.getState.mockImplementation(() => store.getState());
  const wrapper = ({ children }: { children: ReactNode }) => (
    <Provider store={store}>{children}</Provider>
  );
  const hook = renderHook(() => useDeployMods(), { wrapper });

  const setState = (next: IFixture) =>
    act(() => {
      store.dispatch({ type: REPLACE, state: stateFor(next) });
    });

  return { ...hook, setState, store };
};

/** The callback the last `deploy-mods` emit handed the deploy handler. */
const deployCallback = (): ((err: Error | null) => void) =>
  (api.events.emit.mock.calls.at(-1) as unknown[])[1] as never;

const failureIn = (store: Store): IDeploymentFailure | null =>
  (store.getState() as TestState).session.mods.deploymentFailure.fallout4;

describe("useDeployMods", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("asks for a manual deployment of the active game's profile", () => {
    const { result } = render();

    result.current.deploy();

    expect(api.events.emit).toHaveBeenCalledWith(
      "deploy-mods",
      expect.any(Function),
      "profile-a",
      undefined,
      { manual: true },
    );
  });

  // The control shows the outcome; a toast would say it twice.
  it("raises no notification when the deployment completes", () => {
    const { result } = render();

    result.current.deploy();
    act(() => deployCallback()(null));

    expect(api.sendNotification).not.toHaveBeenCalled();
    expect(api.showErrorNotification).not.toHaveBeenCalled();
  });

  it("runs what follows a deployment that completed", () => {
    const { result } = render();
    const onDeployed = vi.fn();

    result.current.deploy(onDeployed);
    act(() => deployCallback()(null));

    expect(onDeployed).toHaveBeenCalledTimes(1);
  });

  // The handler reports its own failures and calls back without an error.
  it("doesn't run it after a deployment that failed", () => {
    const { result, store } = render();
    const onDeployed = vi.fn();

    result.current.deploy(onDeployed);
    act(() => {
      store.dispatch({
        type: "SET_DEPLOYMENT_FAILURE",
        payload: { gameId: "fallout4", failure: { title: "Failed", content: {} } },
      });
      deployCallback()(null);
    });

    expect(onDeployed).not.toHaveBeenCalled();
  });

  it("says nothing when the user cancelled", () => {
    const { result, store } = render();

    result.current.deploy();
    act(() => deployCallback()(new UserCanceled()));

    expect(api.sendNotification).not.toHaveBeenCalled();
    expect(api.showErrorNotification).not.toHaveBeenCalled();
    expect(failureIn(store)).toBeNull();
  });

  it("keeps a failure for the control instead of notifying", () => {
    const { result, store } = render();

    result.current.deploy();
    act(() => deployCallback()(new Error("disk on fire")));

    expect(api.showErrorNotification).not.toHaveBeenCalled();
    expect(failureIn(store)).toMatchObject({
      title: "Failed to activate mods",
      content: { message: expect.stringContaining("disk on fire") },
    });
    expect(result.current.status).toBe("failed");
  });

  it("keeps the notification's words when there is no deployment method", () => {
    const { result, store } = render();

    result.current.deploy();
    act(() => deployCallback()(new NoDeployment()));

    expect(failureIn(store)?.title).toBe("You need to select a deployment method in settings");
  });

  it("reports a missing deployment method without deploying", () => {
    const { result, store } = render({ activator: "not-installed" });

    act(() => result.current.deploy());

    expect(api.events.emit).not.toHaveBeenCalled();
    expect(api.sendNotification).not.toHaveBeenCalled();
    expect(failureIn(store)).toMatchObject({ fix: "deployment-method", warning: true });
  });

  it("keeps notifying in the classic layout", () => {
    const { result } = render({ useModernLayout: false });
    const failure = new Error("disk on fire");

    result.current.deploy();
    deployCallback()(failure);

    expect(api.showErrorNotification).toHaveBeenCalledWith("Failed to activate mods", failure);
  });

  it("shows the failure's details, with a retry", async () => {
    const failure: IDeploymentFailure = {
      title: "Failed to deploy mods",
      content: { text: "disk on fire" },
    };
    const { result } = render({ failure });

    result.current.showFailure();

    expect(api.showDialog).toHaveBeenCalledWith(
      "error",
      "Failed to deploy mods",
      failure.content,
      expect.arrayContaining([
        expect.objectContaining({ label: "Close" }),
        expect.objectContaining({ label: "Retry" }),
      ]),
    );

    const retry = (api.showDialog.mock.calls[0] as unknown[])[3] as Array<{
      label: string;
      action?: () => void;
    }>;
    retry.find((action) => action.label === "Retry")!.action!();

    expect(api.events.emit).toHaveBeenCalledWith(
      "deploy-mods",
      expect.any(Function),
      "profile-a",
      undefined,
      { manual: true },
    );
  });

  it("offers to show the cycles that stopped it", () => {
    const { result } = render({
      failure: {
        title: "Mod rules contain cycles",
        content: { text: "Mod rules contain cycles" },
        cycles: [["a", "b"]],
        warning: true,
      },
    });

    result.current.showFailure();

    const [type, , , actions] = api.showDialog.mock.calls[0] as unknown as [
      string,
      string,
      unknown,
      Array<{ label: string }>,
    ];
    expect(type).toBe("info");
    // the notification's own button
    expect(actions.map((action) => action.label)).toContain("Show");
  });

  // "Mods deployed", which was a 3 second notification.
  it("says Mods deployed for as long as its notification showed", () => {
    vi.useFakeTimers();
    try {
      const { result } = render();

      result.current.deploy();
      act(() => deployCallback()(null));

      expect(result.current.status).toBe("deployed");

      act(() => vi.advanceTimersByTime(DEPLOYED_DISPLAY_MS));

      expect(result.current.status).toBe("idle");
    } finally {
      vi.useRealTimers();
    }
  });

  it("doesn't say Mods deployed after a failure", () => {
    const { result, store } = render();

    result.current.deploy();
    act(() => {
      store.dispatch({
        type: "SET_DEPLOYMENT_FAILURE",
        payload: { gameId: "fallout4", failure: { title: "Failed", content: {} } },
      });
      deployCallback()(null);
    });

    expect(result.current.status).toBe("failed");
  });

  it("passes on the running deployment's percent", () => {
    const { result } = render({
      activity: ["deployment"],
      progress: { text: "Deploying: Some Mod", percent: 60 },
    });

    expect(result.current.progressPercent).toBe(60);
  });

  // "Deployment necessary"'s More, word for word, with its checkbox.
  it("opens the Deployment necessary dialog with the automatic deployment offer", async () => {
    api.showDialog.mockResolvedValueOnce({
      action: "Deploy",
      input: { "enable-auto-deployment": true },
    });
    const { result, store } = render({ needToDeploy: true });
    const dispatch = vi.spyOn(store, "dispatch");

    await act(async () => {
      result.current.showNecessary();
      await Promise.resolve();
    });

    expect(api.showDialog).toHaveBeenCalledWith(
      "question",
      "Deployment necessary",
      {
        text:
          "Recent changes to the active mods are currently pending, " +
          "a deployment must be run to apply the latest changes to your game.",
        checkboxes: [
          { id: "enable-auto-deployment", text: "Enable automatic deployment", value: false },
        ],
      },
      [{ label: "Later" }, { label: "Deploy" }],
    );
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "SET_AUTO_DEPLOYMENT", payload: true }),
    );
    expect(api.events.emit).toHaveBeenCalledWith(
      "deploy-mods",
      expect.any(Function),
      "profile-a",
      undefined,
      { manual: true },
    );
  });

  it("follows whether the game needs deploying", () => {
    const { result, setState } = render({ needToDeploy: true });

    expect(result.current.needToDeploy).toBe(true);

    setState({ needToDeploy: false });

    expect(result.current.needToDeploy).toBe(false);
  });

  // The flag is never written for a game nothing has changed in yet.
  it("treats a game without the flag as deployed", () => {
    const { result } = render({ needToDeploy: undefined });

    expect(result.current.needToDeploy).toBe(false);
    expect(result.current.status).toBe("idle");
  });

  it("is deploying for as long as the deployment activity runs", () => {
    const { result, setState } = render();

    expect(result.current.isDeploying).toBe(false);

    setState({ activity: ["deployment"] });

    expect(result.current.isDeploying).toBe(true);
    expect(result.current.status).toBe("deploying");

    setState({ activity: [] });

    expect(result.current.isDeploying).toBe(false);
  });

  // What the notification would have said, for the control to say instead.
  it("passes on what a running deployment says it is doing", () => {
    const { result } = render({
      activity: ["deployment"],
      progress: { text: "Deploying: Some Mod", percent: 60 },
    });

    expect(result.current.progressText).toBe("Deploying: Some Mod");
    expect(result.current.isWaiting).toBe(false);
  });

  // Progress before the activity: the handler waits for the activation lock.
  it("is waiting, and busy, while a requested deployment hasn't started", () => {
    const { result } = render({
      progress: { text: "Waiting for other operations to complete", percent: 0 },
    });

    expect(result.current.isWaiting).toBe(true);
    expect(result.current.isDeploying).toBe(false);
    expect(result.current.status).toBe("deploying");
  });

  it("isn't waiting once the progress is cleared", () => {
    const { result } = render({ progress: { text: "", percent: 0 } });

    expect(result.current.isWaiting).toBe(false);
    expect(result.current.status).toBe("idle");
  });

  // Purging shares the activity group; it isn't a deployment.
  it("is not deploying while mods are purged", () => {
    const { result } = render({ activity: ["purging"] });

    expect(result.current.isDeploying).toBe(false);
  });
});

describe("deployStatus", () => {
  const failure = { title: "Failed", content: {} };

  it("puts a running deployment first, then a failure, then pending changes", () => {
    expect(deployStatus(true, failure, true)).toBe("deploying");
    expect(deployStatus(false, failure, true)).toBe("failed");
    expect(deployStatus(false, null, true)).toBe("needed");
    expect(deployStatus(false, null, false)).toBe("idle");
    expect(deployStatus(false, null, false, true)).toBe("deployed");
    expect(deployStatus(false, null, true, true)).toBe("needed");
  });
});
