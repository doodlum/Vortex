import path from "path";

import { describe, expect, it } from "vitest";

import type { IGame } from "../../../types/IGame";
import type { IDiscoveryResult } from "../../gamemode_management/types/IDiscoveryResult";
import { executablePath, extensionExecutablePath } from "./getGameVersion";

const game = { executable: () => "game.exe" } as IGame;

describe("executablePath", () => {
  it("joins an executable relative to the discovered game directory", () => {
    expect(executablePath(game, { path: "/games/example" } as IDiscoveryResult)).toBe(
      path.join("/games/example", "game.exe"),
    );
  });

  it("preserves an absolute executable returned by discovery", () => {
    expect(
      executablePath(game, {
        path: "/games/example",
        executable: "/games/example/bin/game.exe",
      } as IDiscoveryResult),
    ).toBe("/games/example/bin/game.exe");
  });

  it("passes extension version providers a path relative to the game directory", () => {
    expect(
      extensionExecutablePath(game, {
        path: "/games/example",
        executable: "/games/example/bin/game.exe",
      } as IDiscoveryResult),
    ).toBe(path.join("bin", "game.exe"));
  });
});
