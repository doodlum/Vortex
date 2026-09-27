import { describe, it, expect } from "vitest";

import { resolveDeployDesign, resolvePlayGate } from "../deployDesigns";
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
    const result = settingsReducer.reducers.SET_DEPLOY_BUTTON_STYLE({ deployButtonStyle: 6 }, 10);
    expect(result).toEqual({ deployButtonStyle: 10 });
  });

  it("has no default, so an untouched setting shows the first variation", () => {
    expect(settingsReducer.defaults).not.toHaveProperty("deployButtonStyle");
  });

  // 1 to 5 were earlier designs, 8 the Progress line row and 9 the Chip row, all removed.
  it.each([1, 2, 3, 4, 5, 8, 9, 42])("records Dot for removed design %i", (style) => {
    const result = settingsReducer.reducers.SET_DEPLOY_BUTTON_STYLE(
      { deployButtonStyle: 7 },
      style,
    );
    expect(result).toEqual({ deployButtonStyle: 6 });
  });
});

describe("resolveDeployDesign", () => {
  it.each([6, 7, 10, 11])("keeps variation %i", (style) => {
    expect(resolveDeployDesign(style)).toBe(style);
  });

  // A stored choice from before a removal, read back from disk.
  it.each([1, 2, 3, 4, 5, 8, 9, undefined])("reads %s as Dot", (style) => {
    expect(resolveDeployDesign(style)).toBe(6);
  });
});

describe("setPlayWhilePending", () => {
  it.each([1, 2, 3])("records gate %i", (style) => {
    expect(settingsReducer.reducers.SET_PLAY_WHILE_PENDING({}, style)).toEqual({
      playWhilePending: style,
    });
  });

  it("records the default for one that doesn't exist", () => {
    expect(settingsReducer.reducers.SET_PLAY_WHILE_PENDING({ playWhilePending: 3 }, 9)).toEqual({
      playWhilePending: 1,
    });
  });

  it("has no default", () => {
    expect(settingsReducer.defaults).not.toHaveProperty("playWhilePending");
  });
});

describe("resolvePlayGate", () => {
  it.each([undefined, 0, 4])("reads %s as Disabled", (style) => {
    expect(resolvePlayGate(style)).toBe(1);
  });
});
