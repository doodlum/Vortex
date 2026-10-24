import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vortex-vfs-overwrite-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
const gamePath = path.join(dir, "Game");
const dataPath = path.join(gamePath, "Data");
const stagingPath = path.join(dir, "staging");

vi.mock("../gamemode_management/util/getGame", () => ({
  getGame: () => ({ getModPaths: (game: string) => ({ "": path.join(game, "Data") }) }),
}));
vi.mock("../../util/selectors", () => ({
  activeGameId: () => "game",
  activeProfile: () => ({ id: "profile", gameId: "game" }),
  installPathForGame: () => stagingPath,
}));

import type { IExtensionApi } from "../../types/IExtensionContext";
import { setOverwrite, setVirtualFiles } from "../../util/vfsFsView";
import { createModFromOverwrite, overwriteSummary } from "./overwrite";
import { OVERWRITE_FOLDER } from "./roots";

const overwrite = path.join(stagingPath, OVERWRITE_FOLDER, "game");
function write(rel: string, text = "") {
  fs.mkdirSync(path.dirname(path.join(overwrite, rel)), { recursive: true });
  fs.writeFileSync(path.join(overwrite, rel), text);
}

describe("files games and tools wrote", () => {
  fs.mkdirSync(path.join(stagingPath, "Mod"), { recursive: true });
  fs.writeFileSync(path.join(stagingPath, "Mod", "mod.esp"), "mod");
  write(path.join("Data", "mod.esp"), "edited");
  write(path.join("Data", "meshes", "out.nif"), "generated");
  write(path.join("Data", ".wh.old.esp"));
  write("skse64.log", "log");
  setVirtualFiles(
    "game|data",
    [gamePath],
    [
      {
        deployed: path.join(dataPath, "mod.esp"),
        source: path.join(stagingPath, "Mod", "mod.esp"),
      },
    ],
  );
  setOverwrite(gamePath, overwrite);

  const emitted: unknown[][] = [];
  const dispatched: unknown[] = [];
  const api = {
    getState: () => ({ settings: { gameMode: { discovered: { game: { path: gamePath } } } } }),
    store: { dispatch: (action: unknown) => dispatched.push(action) },
    events: {
      emit: (...args: unknown[]) => {
        emitted.push(args);
        const callback = args[args.length - 1];
        if (typeof callback === "function") callback(null);
      },
    },
  } as unknown as IExtensionApi;

  it("tells files programs made from their changes and deletions", () => {
    const summary = overwriteSummary(api, "game")!;
    expect(summary.made.map((e) => path.relative(dataPath, e.deployed))).toEqual([
      path.join("meshes", "out.nif"),
    ]);
    expect(summary.madeElsewhere.map((e) => path.basename(e.deployed))).toEqual(["skse64.log"]);
    expect(summary.changed).toBe(1);
    expect(summary.deleted).toBe(1);
  });

  it("makes a mod of the files made in the mod folder, enables and deploys it", async () => {
    const summary = overwriteSummary(api, "game")!;
    const modId = (await createModFromOverwrite(api, "game", summary))!;
    expect(fs.readFileSync(path.join(stagingPath, modId, "meshes", "out.nif"), "utf8")).toBe(
      "generated",
    );
    expect(fs.existsSync(path.join(overwrite, "Data", "meshes", "out.nif"))).toBe(false);
    // The change to a mod's file and the log outside the mod folder stay where they were.
    expect(fs.existsSync(path.join(overwrite, "Data", "mod.esp"))).toBe(true);
    expect(fs.existsSync(path.join(overwrite, "skse64.log"))).toBe(true);
    expect(emitted.map((args) => args[0])).toEqual(["create-mod", "deploy-mods"]);
    expect(dispatched).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ modId, enable: true }) }),
    ]);
    expect(overwriteSummary(api, "game")!.made).toEqual([]);
  });
});
