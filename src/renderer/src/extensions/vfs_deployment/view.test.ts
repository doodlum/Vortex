import * as path from "node:path";

import { describe, expect, it } from "vitest";

import type { IState } from "../../types/IState";
import { virtualSource } from "../../util/vfsFsView";
import { hideDeployment, showDeployment } from "./view";

const gamePath = path.resolve("/games/shared-target");
const staging = path.resolve("/staging");
const state = {
  settings: { gameMode: { discovered: { game: { path: gamePath } } } },
} as unknown as IState;
const file = (relPath: string, source: string) => ({ relPath, source, time: 0 });

describe("mod types that share a target", () => {
  it("keep each other's files, and a purge of the target clears them all", () => {
    // dinput and enb both deploy into the game folder.
    showDeployment(state, "game", "dinput", gamePath, staging, [file("dinput8.dll", "Loader")]);
    showDeployment(state, "game", "enb", gamePath, staging, []);
    expect(virtualSource(path.join(gamePath, "dinput8.dll"))).toBe(
      path.join(staging, "Loader", "dinput8.dll"),
    );
    showDeployment(state, "game", "enb", gamePath, staging, [file("d3d11.dll", "ENB")]);
    expect(virtualSource(path.join(gamePath, "dinput8.dll"))).toBeDefined();
    expect(virtualSource(path.join(gamePath, "d3d11.dll"))).toBeDefined();

    hideDeployment(state, "game", gamePath);
    expect(virtualSource(path.join(gamePath, "dinput8.dll"))).toBeUndefined();
    expect(virtualSource(path.join(gamePath, "d3d11.dll"))).toBeUndefined();
  });
});
