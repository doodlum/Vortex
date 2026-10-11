import { act, renderHook } from "@testing-library/react";
import React, { type ReactNode } from "react";
import { Provider } from "react-redux";
import { createStore, type AnyAction } from "redux";
import { describe, expect, it, vi } from "vitest";

import type { IExtensionApi } from "@/types/IExtensionContext";

const context = vi.hoisted(() => ({ api: undefined as unknown as IExtensionApi }));
vi.mock("@/contexts", () => ({ useMainContext: () => ({ api: context.api }) }));

import { sessionReducer } from "../reducers/session";
import { useDeploymentControl } from "./useDeploymentControl.hook";

function fixture() {
  const initial = {
    settings: { window: { useModernLayout: true }, profiles: { activeProfileId: "p" } },
    persistent: {
      profiles: {
        p: { id: "p", gameId: "game", name: "P", modState: {}, lastActivated: 0 },
        q: { id: "q", gameId: "game", name: "Q", modState: {}, lastActivated: 0 },
        other: { id: "other", gameId: "other-game", name: "Other", modState: {}, lastActivated: 0 },
      },
    },
    session: { mods: { ...sessionReducer.defaults } },
  };
  const store = createStore(
    (state: typeof initial = initial, action: AnyAction): typeof initial => {
      if (action.type === "TEST_ACTIVE_PROFILE") {
        return {
          ...state,
          settings: { ...state.settings, profiles: { activeProfileId: action.payload as string } },
        };
      }
      if (action.type === "TEST_LAYOUT") {
        return {
          ...state,
          settings: { ...state.settings, window: { useModernLayout: action.payload as boolean } },
        };
      }
      const reduce = sessionReducer.reducers[action.type];
      return reduce
        ? { ...state, session: { mods: reduce(state.session.mods, action.payload) } }
        : state;
    },
  );
  context.api = { store, getState: store.getState } as unknown as IExtensionApi;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <Provider store={store}>{children}</Provider>
  );
  return { store, wrapper };
}

describe("mounted deployment control", () => {
  it("registers the matching active profile and clears it when hidden", () => {
    const { store, wrapper } = fixture();
    const { rerender, unmount } = renderHook(
      ({ visible }) => useDeploymentControl("game", visible),
      { wrapper, initialProps: { visible: true } },
    );
    expect(store.getState().session.mods.deploymentControl).toEqual({
      gameId: "game",
      profileId: "p",
      owner: expect.any(String),
    });
    rerender({ visible: false });
    expect(store.getState().session.mods.deploymentControl).toBeUndefined();
    unmount();
  });

  it("follows profile changes without registering another game's profile", () => {
    const { store, wrapper } = fixture();
    const { unmount } = renderHook(() => useDeploymentControl("game", true), { wrapper });
    act(() => {
      store.dispatch({ type: "TEST_ACTIVE_PROFILE", payload: "q" });
    });
    expect(store.getState().session.mods.deploymentControl?.profileId).toBe("q");
    act(() => {
      store.dispatch({ type: "TEST_ACTIVE_PROFILE", payload: "other" });
    });
    expect(store.getState().session.mods.deploymentControl).toBeUndefined();
    unmount();
  });

  it("does not register on Home, for an unknown game or for another game", () => {
    const { store, wrapper } = fixture();
    const { rerender, unmount } = renderHook(
      ({ gameId, visible }) => useDeploymentControl(gameId, visible),
      { wrapper, initialProps: { gameId: "game" as string | undefined, visible: false } },
    );
    expect(store.getState().session.mods.deploymentControl).toBeUndefined();
    rerender({ gameId: undefined, visible: true });
    expect(store.getState().session.mods.deploymentControl).toBeUndefined();
    rerender({ gameId: "other-game", visible: true });
    expect(store.getState().session.mods.deploymentControl).toBeUndefined();
    unmount();
  });

  it("clears registration when switching to the classic layout", () => {
    const { store, wrapper } = fixture();
    const { unmount } = renderHook(() => useDeploymentControl("game", true), { wrapper });
    expect(store.getState().session.mods.deploymentControl).toBeDefined();
    act(() => {
      store.dispatch({ type: "TEST_LAYOUT", payload: false });
    });
    expect(store.getState().session.mods.deploymentControl).toBeUndefined();
    unmount();
  });

  it("an older mounted instance cannot unregister its replacement", () => {
    const { store, wrapper } = fixture();
    const first = renderHook(() => useDeploymentControl("game", true), { wrapper });
    const firstOwner = store.getState().session.mods.deploymentControl?.owner;
    const second = renderHook(() => useDeploymentControl("game", true), { wrapper });
    const secondOwner = store.getState().session.mods.deploymentControl?.owner;
    expect(secondOwner).not.toBe(firstOwner);
    first.unmount();
    expect(store.getState().session.mods.deploymentControl?.owner).toBe(secondOwner);
    second.unmount();
    expect(store.getState().session.mods.deploymentControl).toBeUndefined();
  });
});
