import { act, renderHook } from "@testing-library/react";
import React, { type ReactNode } from "react";
import { Provider } from "react-redux";
import { createStore, type AnyAction } from "redux";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { IExtensionApi } from "@/types/IExtensionContext";
import type { IState } from "@/types/IState";

const context = vi.hoisted(() => ({ api: undefined as unknown as IExtensionApi }));
vi.mock("@/contexts", () => ({ useMainContext: () => ({ api: context.api }) }));

import { sessionReducer } from "../reducers/session";
import { finishDeploymentFeedback, startDeploymentFeedback } from "../util/deploymentFeedback";
import { useDeploymentStatus } from "./useDeploymentStatus.hook";

function fixture() {
  const profile = { id: "p", gameId: "game", name: "P", modState: {}, lastActivated: 0 };
  const initial = {
    settings: { profiles: { activeProfileId: "p" } },
    persistent: {
      profiles: {
        p: profile,
        q: { ...profile, id: "q" },
        other: { ...profile, id: "other", gameId: "other-game" },
      },
    },
    session: { mods: { ...sessionReducer.defaults } },
  };
  const store = createStore(
    (state: typeof initial = initial, action: AnyAction): typeof initial => {
      if (action.type === "TEST_PROFILE")
        return { ...state, settings: { profiles: { activeProfileId: action.payload as string } } };
      const reduce = sessionReducer.reducers[action.type];
      return reduce
        ? { ...state, session: { mods: reduce(state.session.mods, action.payload) } }
        : state;
    },
  );
  const dialog = vi
    .fn<IExtensionApi["showDialog"]>()
    .mockResolvedValue({ action: "Close", input: {} });
  const emit = vi.fn();
  const api = {
    store,
    getState: () => store.getState() as unknown as IState,
    showDialog: dialog,
    events: { emit },
    translate: (s: string) => s,
    closeDialog: vi.fn(),
  } as unknown as IExtensionApi;
  context.api = api;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <Provider store={store}>{children}</Provider>
  );
  const retry = vi.fn();
  const failed = (extra = {}) => {
    const request = startDeploymentFeedback(api, profile);
    finishDeploymentFeedback(api, request, {
      state: "failed",
      error: { title: "Failure", content: { text: "Diagnostic" } },
      ...extra,
    });
    return request;
  };
  return { api, profile, store, wrapper, dialog, emit, retry, failed };
}

afterEach(() => vi.useRealTimers());

describe("deployment status", () => {
  it("shows only the active profile's result", () => {
    const f = fixture();
    f.failed();
    const { result } = renderHook(() => useDeploymentStatus(f.retry), { wrapper: f.wrapper });
    expect(result.current.feedback?.state).toBe("failed");
    act(() => {
      f.store.dispatch({ type: "TEST_PROFILE", payload: "q" });
    });
    expect(result.current.feedback).toBeUndefined();
    act(() => {
      f.store.dispatch({ type: "TEST_PROFILE", payload: "other" });
    });
    expect(result.current.feedback).toBeUndefined();
  });

  it("expires success after its recorded three-second window, without changing Redux", () => {
    vi.useFakeTimers();
    const f = fixture();
    const request = startDeploymentFeedback(f.api, f.profile);
    finishDeploymentFeedback(f.api, request, { state: "deployed" });
    const { result } = renderHook(() => useDeploymentStatus(f.retry), { wrapper: f.wrapper });
    expect(result.current.feedback?.state).toBe("deployed");
    act(() => {
      vi.advanceTimersByTime(2999);
    });
    expect(result.current.feedback?.state).toBe("deployed");
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.feedback).toBeUndefined();
    expect(f.store.getState().session.mods.deploymentFeedback.game.state).toBe("deployed");
  });

  it("an older success timer cannot hide a newer result", () => {
    vi.useFakeTimers();
    const f = fixture();
    const request = startDeploymentFeedback(f.api, f.profile);
    finishDeploymentFeedback(f.api, request, { state: "deployed" });
    const { result } = renderHook(() => useDeploymentStatus(f.retry), { wrapper: f.wrapper });
    act(() => {
      vi.advanceTimersByTime(1000);
      f.failed();
    });
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(result.current.feedback?.state).toBe("failed");
    expect(f.retry).not.toHaveBeenCalled();
  });

  it("mounting later does not restart an already expired success window", () => {
    vi.useFakeTimers();
    const f = fixture();
    const request = startDeploymentFeedback(f.api, f.profile);
    finishDeploymentFeedback(f.api, request, { state: "deployed" });
    vi.advanceTimersByTime(3001);
    const { result } = renderHook(() => useDeploymentStatus(f.retry), { wrapper: f.wrapper });
    expect(result.current.feedback).toBeUndefined();
  });

  it("opens details without retrying, and retries only an explicit action", () => {
    const f = fixture();
    f.failed();
    const { result } = renderHook(() => useDeploymentStatus(f.retry), { wrapper: f.wrapper });
    act(() => result.current.showFailure());
    const [kind, title, content, actions] = f.dialog.mock.calls[0];
    expect([kind, title, content]).toEqual(["error", "Failure", { text: "Diagnostic" }]);
    expect(actions.find((a) => a.label === "Close")?.default).toBe(true);
    expect(f.retry).not.toHaveBeenCalled();
    actions.find((a) => a.label === "Retry")?.action?.();
    expect(f.retry).toHaveBeenCalledOnce();
  });

  for (const replacement of ["profile", "request"] as const) {
    it("a stale details dialog cannot retry after a " + replacement + " change", () => {
      const f = fixture();
      f.failed();
      const { result } = renderHook(() => useDeploymentStatus(f.retry), { wrapper: f.wrapper });
      act(() => result.current.showFailure());
      const actions = f.dialog.mock.calls[0][3];
      act(() => {
        if (replacement === "profile") f.store.dispatch({ type: "TEST_PROFILE", payload: "q" });
        else f.failed();
      });
      actions.find((a) => a.label === "Retry")?.action?.();
      expect(f.retry).not.toHaveBeenCalled();
    });
  }

  it("keeps warning, Fix and third-party Report actions", () => {
    const f = fixture();
    f.failed({
      warning: true,
      fix: "deployment-method",
      error: {
        title: "Method",
        content: { text: "Select a method" },
        reportURL: "https://example.test/issues",
      },
    });
    const { result } = renderHook(() => useDeploymentStatus(f.retry), { wrapper: f.wrapper });
    act(() => result.current.showFailure());
    expect(f.dialog.mock.calls[0][0]).toBe("info");
    const actions = f.dialog.mock.calls[0][3];
    expect(actions.some((a) => a.label === "Report")).toBe(true);
    actions.find((a) => a.label === "Fix")?.action?.();
    expect(f.emit).toHaveBeenCalledWith("show-main-page", "application_settings");
  });

  it("keeps the cyclic-rule editor links in the Show dialog", () => {
    const f = fixture();
    f.failed({ warning: true, cycles: [["mod-a", "mod-b"]] });
    const { result } = renderHook(() => useDeploymentStatus(f.retry), { wrapper: f.wrapper });
    act(() => result.current.showFailure());
    f.dialog.mock.calls[0][3].find((a) => a.label === "Show")?.action?.();
    const [, title, content] = f.dialog.mock.calls[1];
    expect(title).toBe("Cycles");
    content.links?.[0].action?.(vi.fn(), "cycle-dialog");
    expect(f.emit).toHaveBeenCalledWith("edit-mod-cycle", "game", ["mod-a", "mod-b"]);
  });

  it("opens the actual grouped file-failure dialog from Files", () => {
    const f = fixture();
    f.failed({ files: [{ source: "mod", relPath: "locked.ini", outputPath: "/game/locked.ini" }] });
    const { result } = renderHook(() => useDeploymentStatus(f.retry), { wrapper: f.wrapper });
    act(() => result.current.showFailure());
    f.dialog.mock.calls[0][3].find((a) => a.label === "Files")?.action?.();
    const [, title, content] = f.dialog.mock.calls[1];
    expect(title).toBe("Files could not be deployed");
    expect(content.bbcode).toContain("[b]mod[/b]");
    expect(content.bbcode).toContain("[url=cb://reveal/%2Fgame%2Flocked.ini]locked.ini[/url]");
    expect(f.retry).not.toHaveBeenCalled();
  });
});
