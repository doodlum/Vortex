import { describe, it, expect } from "vitest";

import { resolveDeployDesign } from "../deployDesigns";
import settingsReducer from "./interface";

describe("setLanguage", () => {
  it("sets the Language", () => {
    const input = { language: "" };
    const result = settingsReducer.reducers.SET_USER_LANGUAGE(input, "English");
    expect(result).toEqual({ language: "English" });
  });
});

describe("setAdvancedMode", () => {
  it("sets the Advanced Mode", () => {
    const input = { advanced: false };
    const result = settingsReducer.reducers.SET_ADVANCED_MODE(input, {
      advanced: true,
    });
    expect(result).toEqual({ advanced: true });
  });
});

describe("setProfilesVisible", () => {
  it("sets the Profile Visible", () => {
    const input = { profilesVisible: false };
    const result = settingsReducer.reducers.SET_PROFILES_VISIBLE(input, {
      visible: true,
    });
    expect(result).toEqual({ profilesVisible: true });
  });
});

describe("setAlwaysCompactHeaders", () => {
  it("sets the always compact headers preference", () => {
    const input = { alwaysCompactHeaders: false };
    const result = settingsReducer.reducers.SET_ALWAYS_COMPACT_HEADERS(input, true);
    expect(result).toEqual({ alwaysCompactHeaders: true });
  });
});

describe("setReduceMotion", () => {
  it("records the choice", () => {
    const result = settingsReducer.reducers.SET_REDUCE_MOTION({}, true);
    expect(result).toEqual({ reduceMotion: true });
  });

  // Unset means "follow the OS", so an explicit false has to be stored as false rather
  // than left absent.
  it("records turning it back off", () => {
    const result = settingsReducer.reducers.SET_REDUCE_MOTION({ reduceMotion: true }, false);
    expect(result).toEqual({ reduceMotion: false });
  });

  it("has no default, so an untouched setting follows the OS", () => {
    expect(settingsReducer.defaults).not.toHaveProperty("reduceMotion");
  });
});

describe("setDeployButtonStyle", () => {
  it("records the variation picked", () => {
    const result = settingsReducer.reducers.SET_DEPLOY_BUTTON_STYLE({ deployButtonStyle: 6 }, 8);
    expect(result).toEqual({ deployButtonStyle: 8 });
  });

  it("has no default, so an untouched setting shows the first variation", () => {
    expect(settingsReducer.defaults).not.toHaveProperty("deployButtonStyle");
  });

  // 1 to 5 were the earlier designs, all removed.
  it.each([1, 2, 3, 4, 5, 42])("records the first variation for removed design %i", (style) => {
    const result = settingsReducer.reducers.SET_DEPLOY_BUTTON_STYLE(
      { deployButtonStyle: 7 },
      style,
    );
    expect(result).toEqual({ deployButtonStyle: 6 });
  });
});

describe("resolveDeployDesign", () => {
  it.each([6, 7, 8, 9, 10])("keeps variation %i", (style) => {
    expect(resolveDeployDesign(style)).toBe(style);
  });

  // A stored choice from before the change, read back from disk.
  it.each([1, 2, 3, 4, 5, undefined])("reads %s as the first variation", (style) => {
    expect(resolveDeployDesign(style)).toBe(6);
  });
});
