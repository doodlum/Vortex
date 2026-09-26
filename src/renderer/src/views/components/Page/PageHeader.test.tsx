import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import type * as ReactReduxTypes from "react-redux";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Flipped per test, then read by Page through the mocked hook. */
const settings = vi.hoisted(() => ({ interface: { alwaysCompactHeaders: false } }));

vi.mock("react-redux", async () => {
  const actual = await vi.importActual<typeof ReactReduxTypes>("react-redux");

  return {
    ...actual,
    useSelector: (selector: (state: unknown) => unknown) => selector({ settings }),
  };
});

import { Page } from "./Page";
import { PageHeader, PageHeaderActionsContext } from "./PageHeader";
import { PageScroll } from "./PageScroll";

const renderPage = () =>
  render(
    <Page scrollable={false}>
      <PageHeader
        data-testid="header"
        pictogramName="settings"
        subtitle="a subtitle"
        title="a title"
      />

      <PageScroll data-testid="scroll">content</PageScroll>
    </Page>,
  );

const pictogram = () => screen.getByTestId("header").querySelector("svg");

const scrollDown = () =>
  fireEvent.scroll(screen.getByTestId("scroll"), { target: { scrollTop: 40 } });

describe("PageHeader", () => {
  beforeEach(() => {
    settings.interface.alwaysCompactHeaders = false;
  });

  it("starts full height and shrinks once the page is scrolled", () => {
    renderPage();

    expect(pictogram()).toHaveClass("size-14");
    expect(screen.getByText("a subtitle")).not.toHaveClass("hidden");

    scrollDown();

    expect(pictogram()).toHaveClass("size-7");
    expect(screen.getByText("a subtitle")).toHaveClass("hidden");
  });

  // The setting exists to spend no vertical space on the header and to take the
  // shrink animation out of the page, so the compact form has to be there from
  // the first paint rather than waiting on a scroll.
  it("starts compact when the always-compact-headers setting is on", () => {
    settings.interface.alwaysCompactHeaders = true;

    renderPage();

    expect(pictogram()).toHaveClass("size-7");
    expect(screen.getByText("a subtitle")).toHaveClass("hidden");
  });

  // The shadow says content has scrolled under the header, which is true of the
  // scroll position and not of the setting.
  it("keeps its hairline until scrolled, even when always compact", () => {
    settings.interface.alwaysCompactHeaders = true;

    renderPage();

    expect(screen.getByTestId("header")).toHaveClass("border-b");
    expect(screen.getByTestId("header")).not.toHaveClass("shadow-md");

    scrollDown();

    expect(screen.getByTestId("header")).toHaveClass("shadow-md");
  });
  it("places panel controls after the page toolbar without a divider", () => {
    render(
      <PageHeaderActionsContext.Provider value={<button>Close panel</button>}>
        <Page scrollable={false}>
          <PageHeader data-testid="header" title="Mods">
            <button>Page toolbar</button>
          </PageHeader>
        </Page>
      </PageHeaderActionsContext.Provider>,
    );

    const header = screen.getByTestId("header");
    const actions = header.querySelector("[data-panel-header-actions]") as HTMLElement;
    expect(actions).toContainElement(screen.getByRole("button", { name: "Close panel" }));
    expect(actions.querySelector("span[aria-hidden='true']")).toBeNull();
    expect(header.querySelector(".max-w-8xl")).toHaveClass("pr-14");
    expect(screen.getByRole("button", { name: "Page toolbar" })).toBeVisible();
  });
});
