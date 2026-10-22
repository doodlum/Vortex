import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { installedGamePlatform } from "./platform";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Stardew installed target", () => {
  it("selects Windows game and SMAPI files for a Proton install on Linux", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "stardew-target-"));
    directories.push(directory);
    await writeFile(path.join(directory, "Stardew Valley.exe"), "windows fixture");
    expect(installedGamePlatform(directory, "linux")).toBe("win32");
    expect(installedGamePlatform(directory, "darwin")).toBe("darwin");
  });

  it("keeps the native target when the Windows executable is absent", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "stardew-target-"));
    directories.push(directory);
    await writeFile(path.join(directory, "StardewValley"), "native fixture");
    expect(installedGamePlatform(directory, "linux")).toBe("linux");
    expect(installedGamePlatform(directory, "win32")).toBe("win32");
  });
});
