import { act, renderHook } from "@testing-library/react";
import React from "react";
import { Provider } from "react-redux";
import { createStore } from "redux";
import { describe, expect, it, vi } from "vitest";

import type { IMainPage } from "../types/IMainPage";
import { usePageRendering } from "./usePageRendering";

vi.mock("../views/MainPageContainer", () => ({ MainPageContainer: () => null }));

describe("secondary page rendering", () => {
  it("loads an unvisited secondary page and retains it after closing", () => {
    const initial = { session: { base: { mainPage: "mods", secondaryPage: "" } } };
    const store = createStore(
      (state: typeof initial = initial, action: { type: string; page?: string }) =>
        action.type === "secondary"
          ? { session: { base: { ...state.session.base, secondaryPage: action.page ?? "" } } }
          : state,
    );
    const wrapper = ({ children }: React.PropsWithChildren) => (
      <Provider store={store}>{children}</Provider>
    );
    const { result } = renderHook(usePageRendering, { wrapper });
    const page = { id: "Downloads" } as IMainPage;
    expect(result.current.renderPage(page)).toBeNull();
    act(() => {
      store.dispatch({ type: "secondary", page: "Downloads" });
    });
    expect(result.current.renderPage(page)?.props.active).toBe(true);
    expect(result.current.renderPage(page)?.props.secondary).toBe(true);
    act(() => {
      store.dispatch({ type: "secondary", page: "" });
    });
    expect(result.current.renderPage(page)?.props.active).toBe(false);
  });
});
