import { describe, expect, it } from "vitest";

import { parseSteamLaunchOptions } from "./steamLaunchOptions";

describe("parseSteamLaunchOptions", () => {
  it("separates leading assignments, a wrapper and trailing arguments", () => {
    expect(
      parseSteamLaunchOptions(
        `PROTON_LOG=1 DXVK_HUD="fps,memory" gamemoderun %command% -skipintro 'a b'`,
      ),
    ).toEqual({
      env: { PROTON_LOG: "1", DXVK_HUD: "fps,memory" },
      prefix: ["gamemoderun"],
      suffix: ["-skipintro", "a b"],
    });
  });

  it("appends the words as arguments when there is no placeholder, as Steam does", () => {
    expect(parseSteamLaunchOptions("-windowed -nosound")).toEqual({
      env: {},
      prefix: [],
      suffix: ["-windowed", "-nosound"],
    });
    expect(parseSteamLaunchOptions("")).toEqual({ env: {}, prefix: [], suffix: [] });
    expect(parseSteamLaunchOptions("%command%")).toEqual({ env: {}, prefix: [], suffix: [] });
  });

  it("keeps quotes and escapes literal", () => {
    expect(parseSteamLaunchOptions(String.raw`A=it\'s B="x\"y" %command% c\ d`)).toEqual({
      env: { A: "it's", B: 'x"y' },
      prefix: [],
      suffix: ["c d"],
    });
  });

  it("refuses options that would need a shell", () => {
    for (const options of [
      "A=1 %command% | tee log",
      "%command%; rm -rf ~",
      "$HOME/run %command%",
      'A="$(id)" %command%',
      "%command% > out",
      "%command% %command%",
      "A='unterminated %command%",
      "%command% *.ini",
    ])
      expect(parseSteamLaunchOptions(options)).toBeUndefined();
  });
});
