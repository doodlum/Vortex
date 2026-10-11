import { act, render, renderHook, fireEvent } from "@testing-library/react";
import React, { type ReactNode } from "react";
import { Provider } from "react-redux";
import { createStore, type AnyAction } from "redux";
import { describe, expect, it, vi } from "vitest";

import type { IExtensionApi } from "@/types/IExtensionContext";
import type { IState } from "@/types/IState";

import { beginDeploymentFeedback, setDeploymentControl } from "../actions/session";
import { sessionReducer } from "../reducers/session";
import { finishDeploymentFeedback, reportDeploymentIssue } from "../util/deploymentFeedback";
import ActivationButton from "../views/ActivationButton";
import { useDeploymentStatus } from "./useDeploymentStatus.hook";
import { useDeployMods } from "./useDeployMods.hook";

vi.mock("@/controls/ToolbarIcon", () => ({
  default: (props: { onClick: () => void; id: string; disabled?: boolean }) =>
    React.createElement("button", {
      onClick: props.onClick,
      "data-testid": props.id,
      disabled: props.disabled,
    }),
}));

const context = vi.hoisted(() => ({ api: undefined as unknown as IExtensionApi }));
vi.mock("@/contexts", () => ({ useMainContext: () => ({ api: context.api }) }));
vi.mock("../util/deploymentMethods", () => ({ getAllActivators: () => [{ id: "method" }] }));
vi.mock("@/util/errorHandling", () => ({
  didIgnoreError: () => false,
  isOutdated: () => false,
  recordErrorSpan: vi.fn(),
}));
vi.mock("@/util/log", () => ({ log: vi.fn() }));

function fixture(method = "method", visible = true) {
  const profile = { id: "p", gameId: "game", name: "P", modState: {}, lastActivated: 0 };
  const initial = {
    settings: {
      profiles: { activeProfileId: "p", lastActiveProfile: { game: "p" } },
      window: { useModernLayout: true },
      automation: { deploy: false },
      mods: { activator: { game: method } },
    },
    persistent: { profiles: { p: profile }, deployment: { needToDeploy: { game: true } } },
    session: {
      mods: { ...sessionReducer.defaults },
      extensions: { available: [] },
      base: { activity: { mods: [] as string[] }, progress: {} },
    },
  };
  const store = createStore((state = initial, action: AnyAction): typeof initial => {
    if (action.type === "TEST_METHOD")
      return {
        ...state,
        settings: {
          ...state.settings,
          mods: { ...state.settings.mods, activator: { game: action.payload as string } },
        },
      };
    if (action.type === "TEST_ACTIVITY")
      return {
        ...state,
        session: {
          ...state.session,
          base: { activity: { mods: action.payload as string[] }, progress: {} },
        },
      };
    if (action.type === "TEST_DELETE")
      return {
        ...state,
        persistent: { ...state.persistent, profiles: {} as typeof initial.persistent.profiles },
      };
    const reduce = sessionReducer.reducers[action.type];
    return reduce
      ? {
          ...state,
          session: { ...state.session, mods: reduce(state.session.mods, action.payload) },
        }
      : state;
  });
  const emit = vi.fn();
  const api = {
    store,
    getState: () => store.getState() as unknown as IState,
    events: { emit },
    getLoadedExtensions: () => [],
    sendNotification: vi.fn(),
    showErrorNotification: vi.fn(),
    showDialog: vi.fn(),
  } as unknown as IExtensionApi;
  context.api = api;
  if (visible)
    store.dispatch(setDeploymentControl({ gameId: "game", profileId: "p", owner: "test" }));
  const wrapper = ({ children }: { children: ReactNode }) => (
    <Provider store={store}>{children}</Provider>
  );
  return { store, api, emit, wrapper };
}

describe("deployment request hook", () => {
  it("an open failure dialog retries using the currently selected deployment method", () => {
    const f = fixture("missing");
    const { result } = renderHook(
      () => {
        const deployment = useDeployMods();
        return { deployment, status: useDeploymentStatus(deployment.deploy) };
      },
      { wrapper: f.wrapper },
    );
    act(() => result.current.deployment.deploy());
    act(() => result.current.status.showFailure());
    const retry = vi
      .mocked(f.api.showDialog)
      .mock.calls[0][3].find((action) => action.label === "Retry")!;
    act(() => f.store.dispatch({ type: "TEST_METHOD", payload: "method" }));
    act(() => retry.action!());
    expect(f.emit).toHaveBeenCalledOnce();
    expect(f.store.getState().session.mods.deploymentFeedback.game.state).toBe("running");
  });
  it("a retained deploy callback refuses a deployment method removed since its render", () => {
    const f = fixture();
    const { result } = renderHook(() => useDeployMods(), { wrapper: f.wrapper });
    const deploy = result.current.deploy;
    act(() => f.store.dispatch({ type: "TEST_METHOD", payload: "missing" }));
    act(() => deploy());
    expect(f.emit).not.toHaveBeenCalled();
    expect(f.store.getState().session.mods.deploymentFeedback.game).toMatchObject({
      state: "failed",
      fix: "deployment-method",
    });
  });
  it("begins profile-owned feedback before emitting a correlated manual request", () => {
    const f = fixture(),
      { result } = renderHook(() => useDeployMods(), { wrapper: f.wrapper });
    act(() => result.current.deploy());
    const feedback = f.store.getState().session.mods.deploymentFeedback.game;
    expect(feedback).toMatchObject({ profileId: "p", state: "running" });
    expect(f.emit).toHaveBeenCalledWith("deploy-mods", expect.any(Function), "p", undefined, {
      manual: true,
      feedbackId: feedback.requestId,
    });
    act(() => f.emit.mock.calls[0][1](null));
    expect(f.store.getState().session.mods.deploymentFeedback.game.state).toBe("canceled");
    expect(f.api.sendNotification).not.toHaveBeenCalled();
  });

  it("the current manual request stays busy before activity starts and refuses a second click", () => {
    const f = fixture(),
      { result } = renderHook(() => useDeployMods(), { wrapper: f.wrapper });
    act(() => {
      result.current.deploy();
      result.current.deploy();
    });
    expect(f.emit).toHaveBeenCalledOnce();
    expect(f.store.getState().session.base.activity.mods).toEqual([]);
    expect(result.current.isDeploying).toBe(true);
    expect(result.current.deployProgress).toBe(0);
    act(() => f.emit.mock.calls[0][1](null));
    expect(result.current.isDeploying).toBe(false);
    expect(result.current.deployProgress).toBeUndefined();
  });

  it("a running request for another profile does not make this profile busy", () => {
    const f = fixture(),
      { result } = renderHook(() => useDeployMods(), { wrapper: f.wrapper });
    act(() =>
      f.store.dispatch(
        beginDeploymentFeedback({
          gameId: "game",
          profileId: "other",
          requestId: "other-request",
          state: "running",
          changedAt: Date.now(),
        }),
      ),
    );
    expect(result.current.isDeploying).toBe(false);
    act(() => result.current.deploy());
    expect(f.emit).toHaveBeenCalledOnce();
    expect(f.store.getState().session.mods.deploymentFeedback.game.profileId).toBe("p");
  });

  it("the classic control is disabled while its request waits before activity", () => {
    const f = fixture("method", false);
    const view = render(
      <f.wrapper>
        <ActivationButton />
      </f.wrapper>,
    );
    const button = view.getByTestId("deploy-mods") as HTMLButtonElement;
    fireEvent.click(button);
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(f.emit).toHaveBeenCalledOnce();
    act(() => f.emit.mock.calls[0][1](null));
    expect(button.disabled).toBe(false);
  });

  it("keeps pending deployment busy before the engine starts", () => {
    const f = fixture(),
      { result } = renderHook(() => useDeployMods(), { wrapper: f.wrapper });
    act(() => f.store.dispatch({ type: "TEST_ACTIVITY", payload: ["deployment_pending"] }));
    expect(result.current.isDeploying).toBe(true);
    expect(result.current.deployProgress).toBe(0);
  });

  it("a missing method exposes Fix without emitting deployment or a quiet warning toast", () => {
    const f = fixture("missing"),
      { result } = renderHook(() => useDeployMods(), { wrapper: f.wrapper });
    act(() => result.current.deploy());
    expect(f.store.getState().session.mods.deploymentFeedback.game).toMatchObject({
      state: "failed",
      warning: true,
      fix: "deployment-method",
    });
    expect(f.emit).not.toHaveBeenCalled();
    expect(f.api.sendNotification).not.toHaveBeenCalled();
  });

  it("a missing method retains the existing warning and Fix notification outside the menu", () => {
    const f = fixture("missing", false),
      { result } = renderHook(() => useDeployMods(), { wrapper: f.wrapper });
    act(() => result.current.deploy());
    expect(f.api.sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "select-deployment-method-first",
        type: "warning",
        actions: [expect.objectContaining({ title: "Fix" })],
      }),
    );
  });

  it("does not turn a recorded engine failure into success when its callback is null", () => {
    const f = fixture(),
      { result } = renderHook(() => useDeployMods(), { wrapper: f.wrapper });
    act(() => result.current.deploy());
    const feedback = f.store.getState().session.mods.deploymentFeedback.game;
    act(() => {
      reportDeploymentIssue(
        f.api,
        feedback,
        { title: "Failed", options: { allowReport: false } },
        vi.fn(),
      );
      f.emit.mock.calls[0][1](null);
    });
    expect(f.store.getState().session.mods.deploymentFeedback.game.state).toBe("failed");
    expect(f.api.sendNotification).not.toHaveBeenCalled();
    expect(f.api.showErrorNotification).not.toHaveBeenCalled();
  });

  for (const visible of [false, true]) {
    it("shows engine-confirmed success in the correct surface, visible=" + visible, () => {
      const f = fixture("method", visible),
        { result } = renderHook(() => useDeployMods(), { wrapper: f.wrapper });
      act(() => result.current.deploy());
      act(() => {
        finishDeploymentFeedback(f.api, f.store.getState().session.mods.deploymentFeedback.game, {
          state: "deployed",
        });
        f.emit.mock.calls[0][1](null);
      });
      expect(f.store.getState().session.mods.deploymentFeedback.game.state).toBe("deployed");
      expect(f.api.sendNotification).toHaveBeenCalledTimes(visible ? 0 : 1);
    });
  }

  it("a deleted profile cannot emit a deployment against whichever profile is now active", () => {
    const f = fixture(),
      { result } = renderHook(() => useDeployMods(), { wrapper: f.wrapper });
    const deploy = result.current.deploy;
    act(() => f.store.dispatch({ type: "TEST_DELETE" }));
    act(() => deploy());
    expect(f.emit).not.toHaveBeenCalled();
  });
  it("the actual classic button shares outcome handling instead of inferring success from null", () => {
    const f = fixture("method", false);
    f.store.getState().settings.window.useModernLayout = false;
    const view = render(
      <f.wrapper>
        <ActivationButton />
      </f.wrapper>,
    );
    fireEvent.click(view.getByTestId("deploy-mods"));
    const request = f.store.getState().session.mods.deploymentFeedback.game;
    act(() => {
      reportDeploymentIssue(
        f.api,
        request,
        { title: "Classic failure", options: { allowReport: false } },
        () => f.api.showErrorNotification("Classic failure", undefined),
      );
      f.emit.mock.calls[0][1](null);
    });
    expect(f.api.showErrorNotification).toHaveBeenCalledOnce();
    expect(f.api.sendNotification).not.toHaveBeenCalled();
    expect(f.store.getState().session.mods.deploymentFeedback.game.state).toBe("failed");
  });
});
