import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("../gamemode_management/util/getGame", () => ({
  getGame: (gameId: string) =>
    gameId === "steamgame" ? { details: { steamAppId: 489830 } } : { details: {} },
}));

import type { IAetherRoot } from "./aether";
import { steamIdentity } from "./runner";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vortex-vfs-steam-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function gameRoot(name: string): IAetherRoot {
  const location = path.join(dir, name);
  fs.mkdirSync(location, { recursive: true });
  return { location, base: location, files: [] };
}

describe("steamIdentity", () => {
  it("serves steam_appid.txt beside the game and names the app in its environment", () => {
    const root = gameRoot("game");
    const stateDir = path.join(dir, "state");
    const env = steamIdentity(
      "steamgame",
      path.join(root.location, "Game.exe"),
      [root],
      stateDir,
      {},
    );

    expect(env).toEqual({ SteamAppId: "489830", SteamGameId: "489830" });
    expect(root.files).toEqual([
      { path: "steam_appid.txt", source: path.join(stateDir, "steam_appid.txt") },
    ]);
    expect(fs.readFileSync(root.files[0].source, "utf8")).toBe("489830");
    // Nothing is written into the game folder itself.
    expect(fs.readdirSync(root.location)).toEqual([]);
  });

  it("puts the file beside an executable in a subfolder", () => {
    const root = gameRoot("game-bin");
    const exe = path.join(root.location, "bin", "x64", "Game.exe");
    steamIdentity("steamgame", exe, [root], path.join(dir, "state-bin"), {});
    expect(root.files[0].path).toBe(path.join("bin", "x64", "steam_appid.txt"));
  });

  it("leaves a real steam_appid.txt and the caller's own variables alone", () => {
    const root = gameRoot("game-own");
    fs.writeFileSync(path.join(root.location, "steam_appid.txt"), "1");
    const env = steamIdentity(
      "steamgame",
      path.join(root.location, "Game.exe"),
      [root],
      path.join(dir, "s"),
      {
        SteamAppId: "1",
      },
    );
    expect(root.files).toEqual([]);
    expect(env).toEqual({ SteamGameId: "489830" });
  });

  it("does nothing for a game without a Steam app id, or a program outside the game", () => {
    const root = gameRoot("game-other");
    expect(steamIdentity("nosteam", path.join(root.location, "Game.exe"), [root], dir, {})).toEqual(
      {},
    );
    expect(
      steamIdentity("steamgame", path.join(dir, "elsewhere", "Tool.exe"), [root], dir, {}),
    ).toEqual({});
    expect(root.files).toEqual([]);
  });
});
