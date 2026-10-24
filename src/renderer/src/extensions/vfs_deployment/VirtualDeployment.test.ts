import * as nodeFs from "node:fs";
import * as path from "node:path";

import { expect } from "vitest";

import { test } from "../../test-utils/deploymentTest";
import { setOverwrite } from "../../util/vfsFsView";

const FILES = {
  "SkyUI_SE.esp": "esp data",
  "interface/skyui.swf": "swf data",
  "SKSE/Plugins/po3_Tweaks.ini": "[General]",
};

/** Every file under `dir`, relative to it. */
function filesIn(dir: string): string[] {
  return nodeFs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)));
}

test("a deployment records every file and puts nothing into the game folder", async ({
  makeDeployment,
}) => {
  const h = makeDeployment({ files: FILES, method: "vfs" });
  const deployed = await h.deploy();

  expect(filesIn(h.gameDir)).toEqual([]);
  expect(deployed.map((file) => file.relPath.split(path.sep).join("/")).sort()).toEqual(
    Object.keys(FILES).sort(),
  );
  for (const file of deployed) {
    expect(file.source).toBe("SomeMod");
    expect(file.target).toBe("");
    expect(file.time).toBeGreaterThan(0);
  }
  expect(h.method.virtual).toBe(true);
  expect(h.method.isFallbackPurgeSafe).toBe(true);
});

test("the mod activated last wins a conflict, as with links", async ({ makeDeployment }) => {
  const h = makeDeployment({
    files: { "shared.txt": "low", "low-only.txt": "low" },
    otherMods: { HighMod: { "shared.txt": "high", "high-only.txt": "high" } },
    method: "vfs",
  });
  const deployed = await h.deployAll(["SomeMod", "HighMod"]);
  const owner = Object.fromEntries(deployed.map((file) => [file.relPath, file.source]));

  expect(owner).toEqual({
    "shared.txt": "HighMod",
    "low-only.txt": "SomeMod",
    "high-only.txt": "HighMod",
  });
});

test("removing a mod drops only its own records", async ({ makeDeployment }) => {
  const h = makeDeployment({
    files: { "shared.txt": "low", "low-only.txt": "low" },
    otherMods: { HighMod: { "shared.txt": "high", "high-only.txt": "high" } },
    method: "vfs",
  });
  const all = await h.deployAll(["SomeMod", "HighMod"]);
  const afterRemove = await h.remove(all);

  // SomeMod's shared.txt was already replaced by HighMod's, so only its own file goes.
  expect(afterRemove.map((file) => `${file.source}:${file.relPath}`).sort()).toEqual([
    "HighMod:high-only.txt",
    "HighMod:shared.txt",
  ]);
});

test("a partial deployment keeps the records it does not touch", async ({ makeDeployment }) => {
  const h = makeDeployment({
    files: { "a.txt": "a" },
    otherMods: { Other: { "b.txt": "b" } },
    method: "vfs",
  });
  const first = await h.deployMod("Other");
  const second = await h.deploy(first);

  expect(second.map((file) => `${file.source}:${file.relPath}`).sort()).toEqual([
    "Other:b.txt",
    "SomeMod:a.txt",
  ]);
});

test("mods that keep their own folders deploy under them", async ({ makeDeployment }) => {
  const h = makeDeployment({ files: { "x.pak": "pak" }, method: "vfs", modFolders: true });
  const deployed = await h.deploy();

  expect(deployed).toEqual([
    expect.objectContaining({ relPath: "x.pak", source: "SomeMod", target: "SomeMod" }),
  ]);
});

test("finalize without prepare is refused and does not wedge the next deployment", async ({
  makeDeployment,
}) => {
  const h = makeDeployment({ files: { "a.txt": "a" }, method: "vfs" });
  await expect(h.method.finalize("skyrimse", h.gameDir, h.stagingDir)).rejects.toThrow(
    "No deployment in progress",
  );
  await h.method.prepare(h.gameDir, true, [], h.normalize);
  await h.method.cancel(h.gameDir, h.gameDir, h.stagingDir);
  // A cancelled deployment releases its turn.
  expect(await h.deploy()).toHaveLength(1);
});

test("what programs changed of the deployed files is reported as external changes", async ({
  makeDeployment,
}) => {
  const h = makeDeployment({ files: FILES, method: "vfs" });
  const deployed = await h.deploy();
  const overwrite = path.join(h.stagingDir, "__vortex_vfs_overwrite", "game");
  // A tool rewrote the plugin, deleted the ini, and made a file of its own.
  nodeFs.mkdirSync(path.join(overwrite, "SKSE", "Plugins"), { recursive: true });
  nodeFs.writeFileSync(path.join(overwrite, "SkyUI_SE.esp"), "edited");
  nodeFs.writeFileSync(path.join(overwrite, "SKSE", "Plugins", ".wh.po3_Tweaks.ini"), "");
  nodeFs.writeFileSync(path.join(overwrite, "made.log"), "new");
  setOverwrite(h.gameDir, overwrite);
  try {
    const changes = await h.method.externalChanges("game", h.stagingDir, h.gameDir, deployed);
    const byPath = Object.fromEntries(
      changes.map((change) => [change.filePath.split(path.sep).join("/"), change]),
    );
    expect(Object.keys(byPath).sort()).toEqual(["SKSE/Plugins/po3_Tweaks.ini", "SkyUI_SE.esp"]);
    expect(byPath["SkyUI_SE.esp"]).toMatchObject({ changeType: "refchange", source: "SomeMod" });
    expect(byPath["SkyUI_SE.esp"].destTime).toBeInstanceOf(Date);
    expect(byPath["SKSE/Plugins/po3_Tweaks.ini"]).toMatchObject({
      changeType: "deleted",
      source: "SomeMod",
    });
  } finally {
    setOverwrite(h.gameDir, undefined);
  }
});
