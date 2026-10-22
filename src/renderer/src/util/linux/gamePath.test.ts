import { describe, expect, it } from "vitest";

import { isPathInsideGame, isSameGamePath } from "./gamePath";

describe("Steam game path ownership", () => {
  it("requires the associated game directory rather than a shared string prefix", () => {
    expect(isSameGamePath("/games/Foo/.", "/games/Foo")).toBe(true);
    expect(isSameGamePath("/games/FooBar", "/games/Foo")).toBe(false);
    expect(isPathInsideGame("/games/Foo/tools/editor.exe", "/games/Foo")).toBe(true);
    expect(isPathInsideGame("/games/FooBar/editor.exe", "/games/Foo")).toBe(false);
    expect(isPathInsideGame("/games/Foo/../Other/editor.exe", "/games/Foo")).toBe(false);
  });
});
