import * as nodeFs from "node:fs";
import * as path from "node:path";

import { expect, vi } from "vitest";

import { test } from "../../test-utils/deploymentTest";
import { filesStillDeployed } from "./util/activationStore";

test.for(["hardlink", "move"] as const)(
  "%s: purge records actual leftovers before restoring a base with the same timestamp",
  async (method, { makeDeployment }) => {
    const h = makeDeployment({ files: { "Base.json": "mod contents" }, method });
    const source = path.join(h.modDir("SomeMod"), "Base.json");
    const target = h.inGame("Base.json");
    nodeFs.writeFileSync(target, "original contents");
    const timestamp = nodeFs.statSync(source).mtime;
    nodeFs.utimesSync(target, timestamp, timestamp);
    const deployed = await h.deploy();
    await h.method.prePurge(h.stagingDir);
    try {
      // dinput/enb roots may contain another mod type's entire output tree.
      await h.method.purge(h.stagingDir, path.dirname(h.gameDir), "skyrimse");
      await h.method.purge(h.stagingDir, h.gameDir, "skyrimse");
      expect(await filesStillDeployed(h.gameDir, deployed)).toEqual([]);
    } finally {
      await h.method.postPurge();
    }
    expect(nodeFs.readFileSync(target, "utf8")).toBe("original contents");
    expect(nodeFs.readFileSync(source, "utf8")).toBe("mod contents");
    expect(nodeFs.existsSync(target + ".vortex_backup")).toBe(false);
    const next = await h.deploy();
    expect(nodeFs.readFileSync(target, "utf8")).toBe("mod contents");
    expect(nodeFs.readFileSync(target + ".vortex_backup", "utf8")).toBe("original contents");
    expect(next).toHaveLength(1);
  },
);

test("a failed link purge leaves its backup and manifest ownership intact", async ({
  makeDeployment,
}) => {
  const h = makeDeployment({ files: { "Base.json": "mod contents" } });
  const target = h.inGame("Base.json");
  nodeFs.writeFileSync(target, "original contents");
  const deployed = await h.deploy();
  const purge = vi
    .spyOn(h.method as any, "purgeLinks")
    .mockRejectedValue(Object.assign(new Error("injected I/O failure"), { code: "EIO" }));
  await h.method.prePurge(h.stagingDir);
  try {
    await expect(h.method.purge(h.stagingDir, h.gameDir, "skyrimse")).rejects.toThrow(
      "injected I/O failure",
    );
    expect(await filesStillDeployed(h.gameDir, deployed)).toEqual(deployed);
  } finally {
    await h.method.postPurge();
    purge.mockRestore();
  }
  expect(nodeFs.readFileSync(target, "utf8")).toBe("mod contents");
  expect(nodeFs.readFileSync(target + ".vortex_backup", "utf8")).toBe("original contents");
});

test("a standalone purge retains immediate restoration without lifecycle hooks", async ({
  makeDeployment,
}) => {
  const h = makeDeployment({ files: { "Base.json": "mod contents" } });
  const target = h.inGame("Base.json");
  nodeFs.writeFileSync(target, "original contents");
  await h.deploy();
  await h.method.purge(h.stagingDir, h.gameDir, "skyrimse");
  expect(nodeFs.readFileSync(target, "utf8")).toBe("original contents");
});

test("manifest times use milliseconds for the actual walker backend", async ({
  makeDeployment,
}) => {
  const h = makeDeployment({ files: { "Timestamp.json": "mod contents" } });
  const deployed = await h.deploy();
  const expected = nodeFs
    .statSync(path.join(h.modDir("SomeMod"), "Timestamp.json"))
    .mtime.getTime();
  expect(Math.abs(deployed[0].time - expected)).toBeLessThan(1000);
});
