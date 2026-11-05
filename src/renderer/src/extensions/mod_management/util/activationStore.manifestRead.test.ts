import { existsSync, readFileSync } from "node:fs";
import * as nodeFs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, vi } from "vitest";

import { makeDeployedGame } from "../../../test-utils/deployedGame";
import { test } from "../../../test-utils/harnessTest";
import type { IExtensionContext } from "../../../types/IExtensionContext";
import { UserCanceled } from "../../../util/CustomErrors";
import * as vortexFs from "../../../util/fs";
import hardlinkInit from "../../hardlink_activator";
import { fallbackPurge, ownDeployedFiles } from "./activationStore";
import { registerDeploymentMethod } from "./deploymentMethods";

vi.mock("../../../util/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../util/fs")>();
  return { ...actual, readFileAsync: vi.fn(actual.readFileAsync) };
});
hardlinkInit({ api: {}, registerDeploymentMethod } as unknown as IExtensionContext);

async function deployed() {
  const game = await makeDeployedGame();
  const file = await game.deployFile("plugin.esp");
  await game.saveManifest([file], "hardlink_activator");
  const manifest = path.join(game.dataPath, "vortex.deployment.json");
  const before = readFileSync(manifest);
  game.setNextDialog({ action: "Restore from backup", input: {} });
  return { game, file, manifest, before };
}

describe("manifest primary read failures", () => {
  test.for(["EACCES", "EPERM", "EIO", "ENOTDIR", "EISDIR", "ENODEV", undefined])(
    "refuses a failed primary read without treating it as corruption (%s)",
    async (code) => {
      const { game, file, manifest, before } = await deployed();
      const error = Object.assign(new Error("Inert primary read failure"), code ? { code } : {});
      const read = vi.mocked(vortexFs.readFileAsync).mockRejectedValueOnce(error);
      await expect(fallbackPurge(game.api, game.gameId)).rejects.toBe(error);
      expect(read).toHaveBeenCalledWith(manifest, "utf8");
      expect(game.dialogCalls).toEqual([]);
      expect(game.isDeployed(file)).toBe(true);
      expect(readFileSync(manifest)).toEqual(before);
    },
  );

  test("keeps an explicit read cancellation without a recovery dialog", async () => {
    const { game, file } = await deployed();
    const error = new UserCanceled();
    vi.mocked(vortexFs.readFileAsync).mockRejectedValueOnce(error);
    await expect(fallbackPurge(game.api, game.gameId)).rejects.toBe(error);
    expect(game.dialogCalls).toEqual([]);
    expect(game.isDeployed(file)).toBe(true);
  });

  test("keeps the existing empty-manifest behavior for a missing primary", async () => {
    const { game, file, manifest } = await deployed();
    await nodeFs.unlink(manifest);
    await fallbackPurge(game.api, game.gameId);
    expect(game.dialogCalls).toEqual([]);
    expect(game.isDeployed(file)).toBe(true);
  });
});

describe("ownership inspection read failures", () => {
  test("rejects a manifest path that cannot be read as a file", async () => {
    const { game, file, manifest } = await deployed();
    const stage = game.api.getState().settings.mods.installPath[game.gameId];
    await nodeFs.unlink(manifest);
    await nodeFs.mkdir(manifest);
    await expect(ownDeployedFiles(game.api, "", game.dataPath, stage)).rejects.toMatchObject({
      code: "EISDIR",
    });
    expect(game.isDeployed(file)).toBe(true);
    expect(game.dialogCalls).toEqual([]);
  });

  test("still treats missing or malformed ownership data as empty", async () => {
    const { game, manifest } = await deployed();
    const stage = game.api.getState().settings.mods.installPath[game.gameId];
    await nodeFs.writeFile(manifest, '{"damaged');
    await expect(ownDeployedFiles(game.api, "", game.dataPath, stage)).resolves.toEqual([]);
    await nodeFs.unlink(manifest);
    await expect(ownDeployedFiles(game.api, "", game.dataPath, stage)).resolves.toEqual([]);
    expect(existsSync(manifest)).toBe(false);
  });
});
