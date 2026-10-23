import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { describe, expect, it } from "vitest";

import { parseSteamLaunchOptions, readSteamLaunchOptions } from "./steamLaunchOptions";

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

describe("readSteamLaunchOptions", () => {
  const localconfig = (apps: string) =>
    `"UserLocalConfigStore"\n{\n\t"Software"\n\t{\n\t\t"Valve"\n\t\t{\n\t\t\t"Steam"\n\t\t\t{\n\t\t\t\t"apps"\n\t\t\t\t{\n${apps}\n\t\t\t\t}\n\t\t\t}\n\t\t}\n\t}\n}\n`;

  it("reads the active (most recently written) user's options from Steam's files", async () => {
    const steam = await fs.mkdtemp(path.join(os.tmpdir(), "vortex-steam-localconfig-"));
    try {
      const write = async (user: string, body: string, time: number) => {
        const file = path.join(steam, "userdata", user, "config", "localconfig.vdf");
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, body);
        await fs.utimes(file, time, time);
      };
      await write("111", localconfig(`"22380" { "LaunchOptions" "old %command%" }`), 1000);
      await write(
        "222",
        localconfig(`"22380" { "LaunchOptions" "PROTON_LOG=1 %command% \\"-a b\\"" }`),
        2000,
      );
      await expect(readSteamLaunchOptions(steam, "22380")).resolves.toBe(
        'PROTON_LOG=1 %command% "-a b"',
      );
      await expect(readSteamLaunchOptions(steam, "489830")).resolves.toBe("");
    } finally {
      await fs.rm(steam, { recursive: true, force: true });
    }
  });

  it("returns no options without a Steam user and rejects an invalid App ID", async () => {
    const steam = await fs.mkdtemp(path.join(os.tmpdir(), "vortex-steam-localconfig-"));
    try {
      await expect(readSteamLaunchOptions(steam, "22380")).resolves.toBe("");
      await expect(readSteamLaunchOptions(steam, "../1")).rejects.toThrow("Invalid Steam AppID");
    } finally {
      await fs.rm(steam, { recursive: true, force: true });
    }
  });
});
