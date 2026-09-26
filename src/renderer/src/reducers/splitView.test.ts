import { describe, expect, it, vi } from "vitest";

import { splitViewReducer } from "./splitView";
import { verify } from "./verify";

describe("saved split-view state", () => {
  it("repairs corrupt hydrated entries without losing other games or pages", () => {
    const input = {
      pairs: {
        fallout4: { Mods: "Plugins", Tools: 12 },
        broken: null,
        skyrimse: { Mods: "Downloads" },
      },
    };
    const report = vi.fn();
    expect(
      verify(
        "settings.splitView",
        splitViewReducer.verifiers,
        input,
        splitViewReducer.defaults,
        report,
      ),
    ).toEqual({
      pairs: { fallout4: { Mods: "Plugins" }, skyrimse: { Mods: "Downloads" } },
    });
    expect(report).toHaveBeenCalledTimes(2);
  });

  it("rejects a duplicate primary and secondary page", () => {
    expect(
      splitViewReducer.reducers.SET_SPLIT_VIEW(splitViewReducer.defaults, {
        gameId: "fallout4",
        primaryPage: "Mods",
        secondaryPage: "Mods",
      }),
    ).toBe(splitViewReducer.defaults);
  });
});
