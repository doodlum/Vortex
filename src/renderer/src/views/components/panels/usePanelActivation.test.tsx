import { act, fireEvent, render, screen } from "@testing-library/react";
import React, { useLayoutEffect, useMemo, useRef, useState, type PropsWithChildren } from "react";
import { createPortal } from "react-dom";
import { describe, expect, it } from "vitest";

import { usePanelActivation } from "./usePanelActivation";

function Frame({
  id,
  selected,
  activate,
  children,
}: PropsWithChildren<{
  id: string;
  selected: string;
  activate: (id: string) => void;
}>) {
  const frame = usePanelActivation(id, activate);
  return (
    <section ref={frame} data-testid={id} data-focused={selected === id}>
      {children}
    </section>
  );
}

function Page() {
  const [clicks, setClicks] = useState(0);
  return (
    <div data-testid="page-body">
      <button
        data-testid="page-action"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => setClicks((value) => value + 1)}
      >
        {clicks}
      </button>
      <input data-testid="page-input" onFocus={(event) => event.stopPropagation()} />
    </div>
  );
}

function Workspace({ owner = "second" }: { owner?: "first" | "second" | "parking" }) {
  const [selected, setSelected] = useState("first");
  const first = useRef<HTMLDivElement>(null);
  const second = useRef<HTMLDivElement>(null);
  const parking = useRef<HTMLDivElement>(null);
  const pageHost = useMemo(() => document.createElement("div"), []);
  useLayoutEffect(() => {
    ({ first, second, parking })[owner].current?.appendChild(pageHost);
    return () => pageHost.remove();
  }, [owner, pageHost]);
  return (
    <>
      <Frame id="first" selected={selected} activate={setSelected}>
        <div ref={first} />
      </Frame>
      <Frame id="second" selected={selected} activate={setSelected}>
        <div ref={second} />
      </Frame>
      <div ref={parking} />
      {createPortal(<Page />, pageHost)}
    </>
  );
}

describe("panel activation through page portals", () => {
  it("activates a page body and its controls without cancelling stopped-bubbling actions", () => {
    render(<Workspace />);
    fireEvent.pointerDown(screen.getByTestId("page-body"));
    expect(screen.getByTestId("second")).toHaveAttribute("data-focused", "true");

    fireEvent.pointerDown(screen.getByTestId("first"));
    expect(screen.getByTestId("first")).toHaveAttribute("data-focused", "true");
    const action = screen.getByTestId("page-action");
    expect(fireEvent.pointerDown(action)).toBe(true);
    fireEvent.click(action);
    expect(screen.getByTestId("second")).toHaveAttribute("data-focused", "true");
    expect(action).toHaveTextContent("1");
  });

  it("activates on keyboard focus while leaving DOM focus and typing in the page field", () => {
    render(<Workspace />);
    const input = screen.getByTestId("page-input");
    act(() => input.focus());
    expect(screen.getByTestId("second")).toHaveAttribute("data-focused", "true");
    fireEvent.change(input, { target: { value: "filter" } });
    expect(input).toHaveFocus();
    expect(input).toHaveValue("filter");
  });

  it("follows a page moved between panels, preserving its state and ignoring parked pages", () => {
    const { rerender } = render(<Workspace />);
    const action = screen.getByTestId("page-action");
    fireEvent.click(action);
    fireEvent.pointerDown(action);
    expect(screen.getByTestId("second")).toHaveAttribute("data-focused", "true");

    rerender(<Workspace owner="first" />);
    expect(screen.getByTestId("page-action")).toBe(action);
    expect(action).toHaveTextContent("1");
    fireEvent.pointerDown(action);
    expect(screen.getByTestId("first")).toHaveAttribute("data-focused", "true");

    rerender(<Workspace owner="parking" />);
    fireEvent.pointerDown(screen.getByTestId("second"));
    fireEvent.pointerDown(action);
    expect(screen.getByTestId("second")).toHaveAttribute("data-focused", "true");
  });
});
