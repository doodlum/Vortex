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

const Table = SuperTable as React.ComponentType<any>;

const names = (count: number) =>
  Array.from({ length: count }, (_x, i) => `row${String(i).padStart(2, "0")}`);

function renderTable(stickyHeader: boolean, count = 3) {
  const data = Object.fromEntries(names(count).map((name) => [name, { name }]));
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

async function rowsOf(container: HTMLElement, count = 3): Promise<Element[]> {
  await waitFor(() => expect(container.querySelectorAll("tr[data-rowid]")).toHaveLength(count));
  return Array.from(container.querySelectorAll("tr[data-rowid]"));
}

beforeAll(() => {
  window.IntersectionObserver = FakeIntersectionObserver as any;
});

afterEach(() => {
  document.body.innerHTML = "";
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

  // A scrollbar drag moves the view further than a screen before an observer can report the
  // rows it brought into view, so a scroll renders those rows itself, before its frame paints.
  it("renders the rows a scroll brings into view during the scroll event", async () => {
    const ROW_HEIGHT = 40;
    const { container, page, unmount } = renderTable(true, 12);
    const rows = await rowsOf(container, 12);
    let scrollTop = 0;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      function (this: Element) {
        // the page shows 100px; the rows are stacked below its top, moved up by the scroll
        const index = rows.indexOf(this);
        const top = this === page ? 0 : index * ROW_HEIGHT - scrollTop;
        const height = this === page ? 100 : index === -1 ? 0 : ROW_HEIGHT;
        return { top, bottom: top + height, left: 0, right: 100, height, width: 100 } as DOMRect;
      },
    );
    const rendered = () => rows.map((row) => row.textContent.trim() !== "");

    scrollTop = 200;
    page.dispatchEvent(new Event("scroll"));

    // what shows is 200px to 300px down the list; with 120px on each side, rows 1 to 10
    expect(rendered()).toEqual(rows.map((_row, index) => index >= 1 && index <= 10));
    unmount();
  });
});
