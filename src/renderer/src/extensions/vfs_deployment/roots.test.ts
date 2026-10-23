import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { composeRoots, isInside, OVERWRITE_FOLDER, overwriteName } from "./roots";

const game = path.resolve("/games/Skyrim Special Edition");
const staging = path.resolve("/vortex/skyrimse/mods");
const documents = path.resolve("/users/me/Documents/My Games/Skyrim Special Edition");

const file = (relPath: string, source: string, target = "") => ({
  relPath,
  source,
  target,
  time: 1,
});

describe("composeRoots", () => {
  it("puts every target inside the game folder into root 0, at its relative place", () => {
    const roots = composeRoots(
      game,
      staging,
      [
        { targetPath: path.join(game, "Data"), files: [file("SkyUI_SE.esp", "SkyUI")] },
        { targetPath: game, files: [file("skse64_loader.exe", "SKSE")] },
      ],
      true,
    );
    expect(roots).toEqual([
      {
        location: game,
        base: game,
        writeTo: path.join(staging, OVERWRITE_FOLDER, "game"),
        files: [
          {
            path: path.join("Data", "SkyUI_SE.esp"),
            source: path.join(staging, "SkyUI", "SkyUI_SE.esp"),
          },
          { path: "skse64_loader.exe", source: path.join(staging, "SKSE", "skse64_loader.exe") },
        ],
      },
    ]);
  });

  it("gives a target outside the game folder a root of its own, after the game's", () => {
    const roots = composeRoots(
      game,
      staging,
      [{ targetPath: documents, files: [file("SkyrimPrefs.ini", "Tweaks", "sub")] }],
      true,
    );
    expect(roots.map((root) => root.location)).toEqual([game, documents]);
    expect(roots[1].files).toEqual([
      {
        path: path.join("sub", "SkyrimPrefs.ini"),
        source: path.join(staging, "Tweaks", "SkyrimPrefs.ini"),
      },
    ]);
    expect(path.basename(roots[1].writeTo!)).toMatch(/^root-[0-9a-f]{12}$/);
  });

  it("serves a file from its staged spelling when it differs from the deployed one", () => {
    const [root] = composeRoots(
      game,
      staging,
      [{ targetPath: game, files: [{ ...file("data/a.esp", "M"), sourceRelPath: "Data/A.esp" }] }],
      true,
    );
    expect(root.files[0].source).toBe(path.join(staging, "M", "Data/A.esp"));
  });
});

describe("isInside and overwriteName", () => {
  it("compare as the game's file system does", () => {
    expect(isInside(game, path.join(game.toUpperCase(), "Data"), true)).toBe(true);
    // Windows paths always compare case-insensitively; the case-sensitive form is Linux's.
    if (process.platform !== "win32") {
      expect(isInside(game, path.join(game.toUpperCase(), "Data"), false)).toBe(false);
    }
    expect(isInside(game, `${game} Backup`, true)).toBe(false);
    expect(overwriteName(game, game.toLowerCase(), true)).toBe("game");
    expect(overwriteName(game, documents, true)).toBe(overwriteName(game, documents, true));
    expect(overwriteName(game, documents, true)).not.toBe(
      overwriteName(game, path.join(documents, "x"), true),
    );
  });
});
