import { describe, expect, it } from "vitest";

import { commandArguments, executableName } from "./commandLine";

describe("QuickBMS platform and literal command arguments", () => {
  it.each(["x64", "ia32"] as const)("uses the native Linux executable on %s", (arch) => {
    expect(executableName("linux", arch)).toBe("quickbms_4gb_files");
  });
  it("retains the Windows executable", () => {
    expect(executableName("win32", "x64")).toBe("quickbms_4gb_files.exe");
  });
  it.each([
    ["linux", "arm64"],
    ["darwin", "x64"],
  ] as const)("refuses an unsupported %s/%s runtime", (platform, arch) =>
    expect(() => executableName(platform, arch)).toThrow("no bundled runtime"),
  );
  it("keeps shell syntax and whitespace literal in every path", () => {
    const parameters = [
      "/script %PATH% $HOME & literal.bms",
      "/input with space.bin",
      "/output's path",
    ];
    expect(
      commandArguments("l", parameters, { wildCards: ["{}"] }, "/filter & literal.txt"),
    ).toEqual(["-l", "-f", "/filter & literal.txt", ...parameters]);
  });
  it.each([
    [undefined, []],
    [false, ["-r"]],
    [true, ["-r", "-r"]],
  ] as const)("passes resize mode %s as separate tokens", (allowResize, expected) => {
    expect(
      commandArguments("w", ["script", "archive", "output"], { allowResize }, "filter"),
    ).toEqual(["-w", ...expected, "script", "archive", "output"]);
  });
  it("passes supported switches as individual arguments", () => {
    expect(
      commandArguments(
        undefined,
        ["script", "archive", "output"],
        {
          quiet: true,
          overwrite: true,
          caseSensitive: true,
          keepTemporaryFiles: true,
        },
        "filter",
      ),
    ).toEqual(["-q", "-o", "-I", "-T", "script", "archive", "output"]);
  });
});
