import { describe, expect, it } from "vitest";

import { steamRuntimeLaunchEnvironment, type ISteamRuntimeLaunch } from "./steamRuntimeLaunch";

const input: ISteamRuntimeLaunch = {
  protonPath: "/games/tools/steamapps/common/Proton",
  runtimePath: "/runtime-library/steamapps/common/Runtime",
  libraryPaths: ["/games/tools", "/runtime-library", "/games/game-library", "/unrelated"],
  gamePath: "/games/game-library/steamapps/common/Game",
  compatDataPath: "/games/game-library/steamapps/compatdata/42",
  executable: "/external/tools/Reader.exe",
  cwd: "/external/work",
};
const identity = async (p: string) => p;

describe("Steam Runtime mount context", () => {
  it("preserves deliberate additional writable folders alongside required tool/cwd mounts", async () => {
    const result = await steamRuntimeLaunchEnvironment(
      { ...input, extraWritePaths: ["/hdd/mod-data"] },
      identity,
    );
    expect(result.PRESSURE_VESSEL_FILESYSTEMS_RW).toBe(
      "/external/work:/hdd/mod-data:/external/tools",
    );
  });
  it("exports selected tools and involved steamapps roots, plus narrow writable tool/cwd directories", async () => {
    expect(await steamRuntimeLaunchEnvironment(input, identity)).toEqual({
      STEAM_COMPAT_TOOL_PATHS:
        "/games/tools/steamapps/common/Proton:/runtime-library/steamapps/common/Runtime",
      STEAM_COMPAT_LIBRARY_PATHS:
        "/games/tools/steamapps:/runtime-library/steamapps:/games/game-library/steamapps",
      PRESSURE_VESSEL_FILESYSTEMS_RW: "/external/work:/external/tools",
    });
  });
  it("preserves aliases and resolved tool/library/cwd targets, including an executable symlink target", async () => {
    const resolve = async (p: string) =>
      p === "/external/tools/Reader.exe"
        ? "/opt/actual-tool/Reader.exe"
        : p
            .replace(/^\/games/, "/mnt/physical-games")
            .replace(/^\/external\/work$/, "/opt/actual-cwd");
    const result = await steamRuntimeLaunchEnvironment(input, resolve);
    expect(result.STEAM_COMPAT_TOOL_PATHS).toContain(
      "/mnt/physical-games/tools/steamapps/common/Proton",
    );
    expect(result.STEAM_COMPAT_LIBRARY_PATHS).toContain(
      "/mnt/physical-games/game-library/steamapps",
    );
    expect(result.PRESSURE_VESSEL_FILESYSTEMS_RW).toBe(
      "/external/work:/opt/actual-cwd:/external/tools:/opt/actual-tool",
    );
  });
  it("ignores unavailable unrelated libraries", async () => {
    const resolve = async (p: string) => {
      if (p === "/unrelated/steamapps")
        throw Object.assign(new Error("not mounted"), { code: "ENOENT" });
      return p;
    };
    await expect(steamRuntimeLaunchEnvironment(input, resolve)).resolves.toEqual(
      await steamRuntimeLaunchEnvironment(input, identity),
    );
  });
  it("does not export an entire volume for prefix-internal commands or tools inside the selected installation", async () => {
    const result = await steamRuntimeLaunchEnvironment(
      { ...input, executable: "C:\\windows\\system32\\cmd.exe", cwd: input.protonPath },
      identity,
    );
    expect(result.PRESSURE_VESSEL_FILESYSTEMS_RW).toBe("");
    const game = await steamRuntimeLaunchEnvironment(
      { ...input, executable: input.gamePath + "/Game.exe", cwd: input.gamePath },
      identity,
    );
    expect(game.PRESSURE_VESSEL_FILESYSTEMS_RW).toBe("");
  });
  it.each([
    "/",
    "/usr/tools",
    "/lib64/tool",
    "/dev/fd",
    "relative/path",
    "/external/colon:path",
    "/external/new\nline",
  ])("refuses an unsafe or unrepresentable external cwd %s", async (cwd) => {
    await expect(steamRuntimeLaunchEnvironment({ ...input, cwd }, identity)).rejects.toThrow(
      /Steam Runtime/,
    );
  });
  it("refuses a symlink resolving into the container's reserved namespace", async () => {
    await expect(
      steamRuntimeLaunchEnvironment(input, async (p) =>
        p === "/external/tools/Reader.exe" ? "/usr/share/tool/Reader.exe" : p,
      ),
    ).rejects.toThrow("cannot expose this host path unchanged");
  });
});
