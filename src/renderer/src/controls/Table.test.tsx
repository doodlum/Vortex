/**
 * Tests for what a table's rows are virtualised against and scrolled by. A table with a
 * sticky header doesn't scroll itself: its main pane has visible overflow and the page
 * scrolls it, so the rows have to be observed against, and brought into view by, that
 * page scroll, not the pane.
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

// what the table subscribed to on the api's events, such as `<tableId>-scroll-to`
const listeners = new Map<string, (...args: any[]) => void>();

const state = { settings: { interface: { usage: {} } }, persistent: {} };
const store = { getState: () => state, subscribe: () => () => undefined, dispatch: vi.fn() };

class LegacyContext extends React.Component<{ children: React.ReactNode }> {
  public static childContextTypes = { api: PropTypes.object };
  public getChildContext() {
    return {
      api: {
        events: {
          on: (event: string, listener: (...args: any[]) => void) => listeners.set(event, listener),
          emit: vi.fn(),
          removeAllListeners: vi.fn(),
        },
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
  listeners.clear();
  vi.restoreAllMocks();
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

/**
 * Lays an element out for a jsdom that has no layout: a scroll position that sticks, a
 * visible height, and a box that moves up as `scroller` scrolls.
 */
function layOut(
  element: Element,
  box: { top: number; height: number },
  scroller: Element = element,
) {
  if (element === scroller) {
    let scrollTop = 0;
    Object.defineProperty(element, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });
    Object.defineProperty(element, "clientHeight", { configurable: true, value: box.height });
  }
  element.getBoundingClientRect = () =>
    ({
      top: box.top - (element === scroller ? 0 : scroller.scrollTop),
      height: box.height,
    }) as DOMRect;
}

describe("SuperTable scroll-to", () => {
  // A 500px view with row c, the last, ending at 940: well below the fold.
  function layOutRows(scroller: Element, rows: Element[]) {
    layOut(scroller, { top: 0, height: 500 });
    rows.forEach((row, idx) => layOut(row, { top: 800 + idx * 50, height: 40 }, scroller));
  }

  it("scrolls the page around a sticky-header table to the row", async () => {
    const { container, page, pane, unmount } = renderTable(true);
    layOutRows(page, await rowsOf(container));
    // the pane is as tall as its rows, so scrolling it moves nothing
    layOut(pane, { top: 0, height: 1000 });

    listeners.get("test-scroll-to")("c");

    // row c ends at 940; it is brought up to a fifth of the view above the bottom
    expect(page.scrollTop).toBe(940 - 500 + 100);
    expect(pane.scrollTop).toBe(0);
    unmount();
  });

  it("scrolls the pane of any other table to the row", async () => {
    const { container, pane, unmount } = renderTable(false);
    layOutRows(pane, await rowsOf(container));

    listeners.get("test-scroll-to")("c");

    expect(pane.scrollTop).toBe(940 - 500 + 100);
    unmount();
  });
});
