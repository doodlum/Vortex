import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";

import { expect, vi } from "vitest";

// util/Steam reads paths at import time and there is no ApplicationData here
vi.mock("../../../util/getVortexPath", () => ({ default: vi.fn(() => "/tmp") }));

import { makeDeployedFile, makeDeploymentMethod } from "../../../test-utils/builders";
import { makeDeployedGame } from "../../../test-utils/deployedGame";
import { test } from "../../../test-utils/harnessTest";
import { listDeployedFiles, resolveDeployedFile } from "./deployedView";
import { registerDeploymentMethod } from "./deploymentMethods";

const virtual = makeDeploymentMethod({ id: "virtual-method", virtual: true });
const linking = makeDeploymentMethod({ id: "linking-method", priority: 5 });
[virtual, linking].forEach(registerDeploymentMethod);

const byName = (entries: Array<{ name: string }>) =>
  [...entries].sort((a, b) => a.name.localeCompare(b.name));

test("a virtual deployment's files are listed in the folder they are deployed to", async () => {
  const game = await makeDeployedGame({ methodId: virtual.id, stagingTag: true });
  mkdirSync(game.dataPath, { recursive: true });
  writeFileSync(path.join(game.dataPath, "Skyrim.esm"), "game");
  writeFileSync(path.join(game.dataPath, "Replaced.esp"), "game's copy");
  for (const name of ["SkyUI_SE.esp", "Replaced.esp"]) {
    mkdirSync(path.join(game.stagingPath, "SomeMod"), { recursive: true });
    writeFileSync(path.join(game.stagingPath, "SomeMod", name), "mod");
  }
  await game.saveManifest(
    [
      makeDeployedFile({ relPath: "SkyUI_SE.esp", source: "SomeMod" }),
      makeDeployedFile({ relPath: "Replaced.esp", source: "SomeMod" }),
      makeDeployedFile({ relPath: path.join("textures", "a.dds"), source: "SomeMod" }),
    ],
    virtual.id,
  );
  const state = game.api.getState();

  expect(byName(await listDeployedFiles(state, game.gameId, game.dataPath))).toEqual([
    {
      name: "Replaced.esp",
      filePath: path.join(game.stagingPath, "SomeMod", "Replaced.esp"),
      fromMod: true,
    },
    { name: "Skyrim.esm", filePath: path.join(game.dataPath, "Skyrim.esm"), fromMod: false },
    {
      name: "SkyUI_SE.esp",
      filePath: path.join(game.stagingPath, "SomeMod", "SkyUI_SE.esp"),
      fromMod: true,
    },
  ]);
  // A file in a subfolder belongs to that folder's listing, not this one.
  expect(await listDeployedFiles(state, game.gameId, path.join(game.dataPath, "textures"))).toEqual(
    [
      {
        name: "a.dds",
        filePath: path.join(game.stagingPath, "SomeMod", "textures", "a.dds"),
        fromMod: true,
      },
    ],
  );
  expect(
    await resolveDeployedFile(state, game.gameId, path.join(game.dataPath, "SkyUI_SE.esp")),
  ).toBe(path.join(game.stagingPath, "SomeMod", "SkyUI_SE.esp"));
  expect(
    await resolveDeployedFile(state, game.gameId, path.join(game.dataPath, "Skyrim.esm")),
  ).toBe(path.join(game.dataPath, "Skyrim.esm"));
  expect(
    await resolveDeployedFile(state, game.gameId, path.join(game.dataPath, "missing.esp")),
  ).toBeUndefined();
});

test("a game deployed with links lists only its real folder", async () => {
  const game = await makeDeployedGame({ methodId: linking.id, stagingTag: true });
  mkdirSync(game.dataPath, { recursive: true });
  writeFileSync(path.join(game.dataPath, "Skyrim.esm"), "game");
  // A stray virtual manifest (from an earlier switch, say) must not leak in.
  await game.saveManifest(
    [makeDeployedFile({ relPath: "SkyUI_SE.esp", source: "SomeMod" })],
    virtual.id,
  );

  expect(await listDeployedFiles(game.api.getState(), game.gameId, game.dataPath)).toEqual([
    { name: "Skyrim.esm", filePath: path.join(game.dataPath, "Skyrim.esm"), fromMod: false },
  ]);
});

test("a folder that cannot be read is reported, as a plain readdir would", async () => {
  const game = await makeDeployedGame({ methodId: virtual.id, stagingTag: true });
  await expect(
    listDeployedFiles(game.api.getState(), game.gameId, path.join(game.dataPath, "missing")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});
