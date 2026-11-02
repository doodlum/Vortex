import { describe, expect, it } from "vitest";

import { isWindowsCommandInterpreter, windowsVerbatimArguments } from "./windowsCommandLine";

describe.runIf(process.platform === "win32")("Windows command argument boundary", () => {
  it("recognises an explicitly selected command interpreter and retains ordinary executable escaping", () => {
    expect(isWindowsCommandInterpreter("C:\\Windows\\System32\\CMD.EXE")).toBe(true);
    expect(isWindowsCommandInterpreter("C:\\tools\\other-cmd.exe")).toBe(false);
    expect(windowsVerbatimArguments("C:\\tools\\Tool.exe", false)).toBe(false);
    expect(windowsVerbatimArguments("C:\\Windows\\System32\\CMD.EXE", false)).toBe(true);
    expect(windowsVerbatimArguments("C:\\tools\\Tool.exe", true)).toBe(true);
  });
});
