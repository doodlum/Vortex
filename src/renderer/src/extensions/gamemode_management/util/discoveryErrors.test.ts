import { describe, expect, it } from "vitest";

import { isExpectedDiscoveryMiss } from "./discoveryErrors";

describe("isExpectedDiscoveryMiss", () => {
  it.each([
    "Currently only discovered on windows",
    "Epic Games Launcher is not available on this platform",
    "No supported game store for Surviving Mars on this platform",
    "winapi.RegGetValue is not a function",
  ])("accepts an unsupported Linux discovery integration: %s", (message) => {
    expect(isExpectedDiscoveryMiss(new Error(message), "linux")).toBe(true);
  });

  it("accepts a game that is simply not installed", () => {
    expect(
      isExpectedDiscoveryMiss(new Error("Stardew Valley install path not found"), "linux"),
    ).toBe(true);
  });

  it("does not hide real extension failures", () => {
    expect(isExpectedDiscoveryMiss(new Error("Cannot read properties of undefined"), "linux")).toBe(
      false,
    );
  });

  it("does not classify Windows API failures as expected on Windows", () => {
    expect(
      isExpectedDiscoveryMiss(new Error("winapi.RegGetValue is not a function"), "win32"),
    ).toBe(false);
  });
});
