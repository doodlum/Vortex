import { expect, vi } from "vitest";

vi.mock("../../util/getVortexPath", () => ({ default: vi.fn(() => "/tmp") }));

import { makeDeployedGame } from "../../test-utils/deployedGame";
import { test } from "../../test-utils/harnessTest";
import VirtualDeployment, { VFS_DEPLOYMENT_ID } from "../vfs_deployment/VirtualDeployment";
import { genUpdateModDeployment, onDeploySingleMod } from "./index";
import type InstallManager from "./InstallManager";
import { getManifest } from "./util/activationStore";
import { registerDeploymentMethod } from "./util/deploymentMethods";
import { registerDeploymentPreparation } from "./util/deploymentPreparation";

const virtual = new VirtualDeployment(() => undefined);
registerDeploymentMethod(virtual);

test("single-mod deployment awaits core preparation and releases it after saving the new manifest", async () => {
  const game = await makeDeployedGame({ methodId: VFS_DEPLOYMENT_ID, stagingTag: true });
  await game.deployMods(virtual, ["Probe"]);
  const before = await getManifest(game.api, "", game.gameId, true);
  const unregisterBlocked = registerDeploymentPreparation(async () => {
    throw new Error("still mounted");
  });
  try {
    await expect(onDeploySingleMod(game.api)(game.gameId, "Probe", false)).rejects.toThrow(
      "still mounted",
    );
    expect((await getManifest(game.api, "", game.gameId, true)).files).toEqual(before.files);
  } finally {
    unregisterBlocked();
  }
  const released = vi.fn(async () => {
    expect((await getManifest(game.api, "", game.gameId, true)).files).toEqual([]);
  });
  const prepare = vi.fn(async () => released);
  const unregister = registerDeploymentPreparation(prepare);
  try {
    await onDeploySingleMod(game.api)(game.gameId, "Probe", false);
    expect(prepare).toHaveBeenCalledExactlyOnceWith(game.gameId, "deploy");
    expect(released).toHaveBeenCalledExactlyOnceWith(true);
  } finally {
    unregister();
  }
});

test("full deployment stops at rejected preparation before loading manifests or merging", async () => {
  const game = await makeDeployedGame({ methodId: VFS_DEPLOYMENT_ID, stagingTag: true });
  game.setState((draft) => {
    Object.assign(draft.settings, { window: { useModernLayout: true } });
  });
  await game.deployMods(virtual, ["Probe"]);
  const before = await getManifest(game.api, "", game.gameId, true);
  const prepare = vi.fn(async () => {
    throw new Error("still mounted");
  });
  const unregister = registerDeploymentPreparation(prepare);
  const installManager = {
    getActiveInstallationCount: () => 0,
    consumeRecentChanges: () => new Set(),
  } as unknown as InstallManager;
  try {
    await expect(
      genUpdateModDeployment(installManager)(game.api, true, game.profileId, undefined, {
        failOnError: true,
      }),
    ).rejects.toThrow("still mounted");
    expect(prepare).toHaveBeenCalledExactlyOnceWith(game.gameId, "deploy");
    expect((await getManifest(game.api, "", game.gameId, true)).files).toEqual(before.files);
  } finally {
    unregister();
  }
});
