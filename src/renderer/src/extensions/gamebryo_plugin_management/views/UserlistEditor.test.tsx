import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { Provider } from "react-redux";
import { createStore } from "redux";
import { describe, expect, it, vi } from "vitest";

import userlistReducer from "../reducers/userlist";
import DependencyIcon from "./DependencyIcon";
import UserlistEditor from "./UserlistEditor";

// Font loading, select menus and drag transport are unrelated to rule removal.
vi.mock("../../../controls/Icon", () => ({ default: () => null }));
vi.mock("../../../controls/Advanced", () => ({ default: ({ children }) => children }));
vi.mock("react-select", () => ({ default: () => null }));
vi.mock("react-i18next", () => ({
  withTranslation: () => (Component) => (props) => <Component {...props} t={(key) => key} />,
}));
vi.mock("react-dnd", () => {
  const wrap = () => (Component) => (props) => (
    <Component
      {...props}
      connectDragPreview={() => undefined}
      connectDragSource={(element) => element}
      connectDropTarget={(element) => element}
    />
  );
  return { DragSource: wrap, DropTarget: wrap };
});
vi.mock("react-dnd-html5-backend", () => ({ getEmptyImage: () => new Image() }));
vi.mock("../../../controls/TooltipControls", () => ({
  IconButton: React.forwardRef<HTMLButtonElement, any>((props, ref) => (
    <button
      ref={ref}
      id={props.id}
      className={props.className}
      onClick={props.onClick}
      aria-label={props.icon}
    />
  )),
  Button: ({ children, onClick, disabled }) => (
    <button onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));

function makeStore(list: string) {
  const reference = { name: "Other.esp", display: "Other mod", condition: 'active("A.esp")' };
  const retained = { ...reference, condition: 'active("B.esp")' };
  const initial = {
    userlist: { plugins: [{ name: "Example.esp", [list]: [reference, retained] }], groups: [] },
    session: {
      plugins: { pluginList: {} },
      pluginDependencies: {
        dialog: undefined as { pluginId: string; gameId: string } | undefined,
        quickEdit: {},
      },
    },
    settings: { profiles: {} },
  };
  const store = createStore((state: typeof initial = initial, action: any): typeof initial => {
    if (action.type === "open")
      return {
        ...state,
        session: {
          ...state.session,
          pluginDependencies: {
            ...state.session.pluginDependencies,
            dialog: { pluginId: "Example.esp", gameId: "skyrimse" },
          },
        },
      };
    const reducer = userlistReducer.reducers[action.type];
    return reducer === undefined
      ? state
      : { ...state, userlist: reducer(state.userlist, action.payload) as typeof state.userlist };
  });
  return { store, reference, retained };
}

describe("editing imported conditional rules", () => {
  it.each(["after", "req", "inc"])(
    "renders and removes one %s rule in the editor",
    async (list) => {
      const { store, reference, retained } = makeStore(list);
      render(
        <Provider store={store}>
          <UserlistEditor />
        </Provider>,
      );
      act(() => {
        store.dispatch({ type: "open" });
      });
      const rows = await screen.findAllByTestId("plugin-rule");
      expect(rows).toHaveLength(2);
      expect(rows[0].querySelectorAll(".rule-name")[1].textContent).toBe(reference.display);
      expect(rows[0].querySelectorAll(".rule-name")[1]).toHaveAttribute(
        "title",
        reference.condition,
      );
      fireEvent.click(within(rows[0]).getByRole("button"));
      expect(store.getState().userlist.plugins[0][list]).toEqual([retained]);
      await waitFor(() => expect(screen.getAllByTestId("plugin-rule")).toHaveLength(1));
    },
  );

  it.each(["after", "req", "inc"])(
    "removes the selected %s condition in the dependency popover",
    async (list) => {
      const { store, reference, retained } = makeStore(list);
      const { container } = render(
        <Provider store={store}>
          <DependencyIcon
            plugin={{ id: "Example.esp", name: "Example.esp" }}
            t={(key) => key}
            onHighlight={() => undefined}
          />
        </Provider>,
      );
      fireEvent.click(container.querySelector('[id="btn-meta-data-Example.esp"]'));
      const rows = await screen.findAllByRole("listitem");
      expect(rows).toHaveLength(2);
      expect(rows[0]).toHaveAttribute("title", reference.condition);
      fireEvent.click(within(rows[0]).getByRole("button"));
      expect(store.getState().userlist.plugins[0][list]).toEqual([retained]);
    },
  );
});
