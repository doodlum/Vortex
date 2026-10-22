import * as path from "path";

import Bluebird from "bluebird";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { copyAsync, log } = vi.hoisted(() => ({
  copyAsync: vi.fn(),
  log: vi.fn(),
}));

vi.mock("@nexusmods/vortex-api", () => ({
  fs: { copyAsync },
  log,
}));

import { copyGameSettings } from "./copyGameSettings";

describe("copyGameSettings", () => {
  beforeEach(() => {
    copyAsync.mockReset();
    log.mockReset();
    vi.stubGlobal("process", { ...process, platform: "linux" });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps a missing .base file fatal on Windows", async () => {
    vi.stubGlobal("process", { ...process, platform: "win32" });
    copyAsync.mockImplementation(() => Bluebird.reject({ code: "ENOENT" }));

    await expect(
      copyGameSettings("/docs", "/profiles", [{ name: "Oblivion.ini", optional: false }], "GloPro"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(copyAsync).toHaveBeenCalledTimes(1);
  });

  it("falls back to the live ini when the .base file does not exist", async () => {
    const sourcePath = "/proton/Documents/My Games/Oblivion";
    const destinationPath = "/profiles/oblivion";
    const baseSource = path.join(sourcePath, "Oblivion.ini.base");
    const liveSource = path.join(sourcePath, "Oblivion.ini");
    const destination = path.join(destinationPath, "Oblivion.ini");

    copyAsync
      .mockImplementationOnce(() => Bluebird.reject({ code: "ENOENT" }))
      .mockImplementation(() => Bluebird.resolve());

    await copyGameSettings(
      sourcePath,
      destinationPath,
      [{ name: "Oblivion.ini", optional: false }],
      "GloPro",
    );

    expect(copyAsync).toHaveBeenNthCalledWith(1, baseSource, destination, { noSelfCopy: true });
    expect(copyAsync).toHaveBeenNthCalledWith(2, liveSource, destination, { noSelfCopy: true });
  });

  it("falls back to the live ini when backing up global settings without a .base file", async () => {
    const sourcePath = "/proton/Documents/My Games/Oblivion";
    const destinationPath = "/backups/oblivion";
    const baseSource = path.join(sourcePath, "Oblivion.ini.base");
    const liveSource = path.join(sourcePath, "Oblivion.ini");
    const destination = path.join(destinationPath, "Oblivion.ini");

    copyAsync
      .mockImplementationOnce(() => Bluebird.reject({ code: "ENOENT" }))
      .mockImplementation(() => Bluebird.resolve());

    await copyGameSettings(
      sourcePath,
      destinationPath,
      [{ name: "Oblivion.ini", optional: false }],
      "GloBac",
    );

    expect(copyAsync).toHaveBeenNthCalledWith(1, baseSource, destination, { noSelfCopy: true });
    expect(copyAsync).toHaveBeenNthCalledWith(2, liveSource, destination, { noSelfCopy: true });
  });

  it("uses the .base file when it exists", async () => {
    const sourcePath = "/proton/Documents/My Games/Oblivion";
    const destinationPath = "/profiles/oblivion";
    const baseSource = path.join(sourcePath, "Oblivion.ini.base");
    const destination = path.join(destinationPath, "Oblivion.ini");

    copyAsync.mockImplementation(() => Bluebird.resolve());

    await copyGameSettings(
      sourcePath,
      destinationPath,
      [{ name: "Oblivion.ini", optional: false }],
      "GloPro",
    );

    expect(copyAsync).toHaveBeenCalledTimes(1);
    expect(copyAsync).toHaveBeenCalledWith(baseSource, destination, { noSelfCopy: true });
  });
});
