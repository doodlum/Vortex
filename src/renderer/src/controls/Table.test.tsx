/**
 * Tests for what a table's rows are virtualised against. A table with a sticky header
 * doesn't scroll itself: its main pane has visible overflow and the page scrolls it, so
 * the rows have to be observed against that page scroll, not the pane.
 */
import { render, waitFor } from "@testing-library/react";
import * as PropTypes from "prop-types";
import * as React from "react";
import { Provider } from "react-redux";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import SuperTable from "./Table";
import HeaderCell from "./table/HeaderCell";

// Render the bare table: no store, extension registry or i18n instance to set up.
vi.mock("./ComponentEx", async (importOriginal) => {
  const identity = () => (component: unknown) => component;
  return {
    ...(await importOriginal<object>()),
    connect: identity,
    extend: identity,
    translate: identity,
  };
});

const observedRoots = new Map<Element, Element | null>();

class FakeIntersectionObserver {
  private mRoot: Element | null;
  constructor(_callback: unknown, options: IntersectionObserverInit) {
    this.mRoot = (options.root as Element) ?? null;
  }
  public observe(target: Element) {
    observedRoots.set(target, this.mRoot);
  }
  public unobserve(target: Element) {
    observedRoots.delete(target);
  }
  public disconnect() {
    // nop
  }
}

const state = { settings: { interface: { usage: {} } }, persistent: {} };
const store = { getState: () => state, subscribe: () => () => undefined, dispatch: vi.fn() };

class LegacyContext extends React.Component<{ children: React.ReactNode }> {
  public static childContextTypes = { api: PropTypes.object };
  public getChildContext() {
    return {
      api: {
        events: { on: vi.fn(), emit: vi.fn(), removeAllListeners: vi.fn() },
        getState: () => state,
        store,
      },
    };
  }
  public render() {
    return <Provider store={store as never}>{this.props.children}</Provider>;
  }
}

const attributes = [
  {
    id: "name",
    name: "Name",
    placement: "table",
    calc: (row: { name: string }) => row.name,
    edit: {},
    noShrink: true,
  },
];

const data = { a: { name: "a" }, b: { name: "b" }, c: { name: "c" } };

const Table = SuperTable as React.ComponentType<any>;

function renderTable(stickyHeader: boolean) {
  // stands in for the page scroll around a sticky-header table
  const page = document.createElement("div");
  page.style.overflowY = "auto";
  const host = document.createElement("div");
  page.appendChild(host);
  document.body.appendChild(page);

  const result = render(
    <LegacyContext>
      <Table
        t={(key: string) => key}
        tableId="test"
        data={data}
        objects={attributes}
        actions={[]}
        attributeState={{}}
        language="en"
        collapsedGroups={[]}
        hasActions={false}
        showDetails={false}
        stickyHeader={stickyHeader}
        onSetAttributeVisible={vi.fn()}
        onSetAttributeSort={vi.fn()}
        onSetAttributeFilter={vi.fn()}
        onSetGroupingAttribute={vi.fn()}
        onCollapseGroup={vi.fn()}
        onSetCollapsedGroups={vi.fn()}
      />
    </LegacyContext>,
    { container: host },
  );
  const pane = host.querySelector(".table-main-pane");
  return { ...result, page, pane };
}

async function rowsOf(container: HTMLElement): Promise<Element[]> {
  await waitFor(() => expect(container.querySelectorAll("tr[data-rowid]")).toHaveLength(3));
  return Array.from(container.querySelectorAll("tr[data-rowid]"));
}

beforeAll(() => {
  window.IntersectionObserver = FakeIntersectionObserver as any;
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SuperTable row virtualisation", () => {
  it("observes the rows of a sticky-header table against the page scroll", async () => {
    const { container, page, unmount } = renderTable(true);

    for (const row of await rowsOf(container)) {
      expect(observedRoots.get(row)).toBe(page);
    }
    unmount();
  });

  it("observes the rows of any other table against its own pane", async () => {
    const { container, pane, unmount } = renderTable(false);

    for (const row of await rowsOf(container)) {
      expect(observedRoots.get(row)).toBe(pane);
    }
    unmount();
  });

  it("keeps noShrink columns from shrinking while the page scrolls, until unmounted", async () => {
    const updateWidth = vi.spyOn(HeaderCell.prototype, "updateWidth");
    const { container, page, unmount } = renderTable(true);
    await rowsOf(container);

    page.dispatchEvent(new Event("scroll"));
    expect(updateWidth).toHaveBeenCalled();

    unmount();
    updateWidth.mockClear();
    page.dispatchEvent(new Event("scroll"));
    expect(updateWidth).not.toHaveBeenCalled();
  });
});

it("preserves header widths while hidden and resizes them immediately when shown again", async () => {
  const observers = new Map<Element, () => void>();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      private target: Element | undefined;
      constructor(private callback: () => void) {}
      observe(target: Element) {
        this.target = target;
        observers.set(target, this.callback);
      }
      disconnect() {
        if (this.target) observers.delete(this.target);
      }
    },
  );
  const { container, unmount } = renderTable(false);
  await rowsOf(container);
  const proxy = container.querySelector(".table-main-pane .table-header tr")!;
  const header = container.querySelector(".table-header-pane .table-header tr")!;
  let width = 140;
  Object.defineProperty(proxy, "clientWidth", { get: () => width * proxy.children.length });
  for (const cell of proxy.children)
    Object.defineProperty(cell, "clientWidth", { get: () => width });
  const resize = observers.get(proxy)!;
  resize();
  expect((header.firstElementChild as HTMLElement).style.minWidth).toBe("140px");
  width = 0;
  resize();
  expect((header.firstElementChild as HTMLElement).style.minWidth).toBe("140px");
  width = 220;
  resize();
  expect((header.firstElementChild as HTMLElement).style.minWidth).toBe("220px");
  unmount();
  expect(observers.has(proxy)).toBe(false);
});
