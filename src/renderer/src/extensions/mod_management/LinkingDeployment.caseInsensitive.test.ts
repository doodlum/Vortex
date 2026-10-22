import * as nodeFs from "node:fs";
import * as path from "node:path";

import { expect, vi } from "vitest";

import { makeDeployedFile } from "../../test-utils/builders";
import { test } from "../../test-utils/deploymentTest";
import * as deploymentFs from "../../util/fs";
import BlacklistSet from "./util/BlacklistSet";

// Windows file systems fold case themselves; these cover case-sensitive ones
const caseSensitiveTest = test.skipIf(process.platform === "win32");

caseSensitiveTest(
  "redeploys a case-only rename in the same mod with unchanged timestamp",
  async ({ makeDeployment }) => {
    const h = makeDeployment({ files: { "Textures/a.dds": "content" } });
    const first = await h.deploy();
    const original = path.join(h.modDir("SomeMod"), "Textures", "a.dds");
    const renamed = path.join(h.modDir("SomeMod"), "Textures", "A.dds");
    nodeFs.renameSync(original, renamed);
    const deployed = await h.deployAll(["SomeMod"], first);
    expect(nodeFs.readFileSync(path.join(h.gameDir, "Textures", "a.dds"), "utf8")).toBe("content");
    expect(nodeFs.existsSync(path.join(h.gameDir, "Textures", "A.dds"))).toBe(false);
    expect(deployed.map((file) => file.relPath)).toEqual([path.join("Textures", "a.dds")]);
    expect(deployed[0].sourceRelPath).toBe(path.join("Textures", "A.dds"));
    expect(await h.method.externalChanges("skyrimse", h.stagingDir, h.gameDir, deployed)).toEqual(
      [],
    );
  },
);

caseSensitiveTest(
  "deploys only the later mod's file when two mods ship it with different case",
  async ({ makeDeployment }) => {
    const h = makeDeployment({
      files: { "Textures/a.dds": "first" },
      otherMods: { Other: { "textures/A.dds": "second" } },
    });

    const deployed = await h.deployMod("Other", await h.deploy());

    expect(nodeFs.readFileSync(path.join(h.gameDir, "Textures", "a.dds"), "utf8")).toBe("second");
    expect(nodeFs.existsSync(path.join(h.gameDir, "textures", "A.dds"))).toBe(false);
    expect(deployed[0].sourceRelPath).toBe(path.join("textures", "A.dds"));
    expect(deployed.map((file) => file.source)).toEqual(["Other"]);
  },
);

caseSensitiveTest(
  "removes a case variant an earlier deployment left next to the winning file",
  async ({ makeDeployment }) => {
    const h = makeDeployment({
      files: { "Textures/a.dds": "first" },
      otherMods: { Other: { "textures/A.dds": "second" } },
    });
    const first = await h.deploy();
    nodeFs.mkdirSync(path.join(h.gameDir, "textures"));
    nodeFs.linkSync(
      path.join(h.modDir("Other"), "textures", "A.dds"),
      path.join(h.gameDir, "textures", "A.dds"),
    );
    const legacy = [...first, makeDeployedFile({ relPath: "textures/A.dds", source: "Other" })];

    const deployed = await h.deployAll(["SomeMod", "Other"], legacy);

    expect(nodeFs.existsSync(path.join(h.gameDir, "Textures", "a.dds"))).toBe(false);
    expect(nodeFs.readFileSync(path.join(h.gameDir, "textures", "A.dds"), "utf8")).toBe("second");
    expect(deployed.map((file) => file.source)).toEqual(["Other"]);
  },
);

caseSensitiveTest(
  "releases the deployment queue after refusing an ambiguous destination",
  async ({ makeDeployment }) => {
    const h = makeDeployment({ files: { "DATA/file.ini": "mod" } });
    nodeFs.mkdirSync(path.join(h.gameDir, "Data"));
    nodeFs.mkdirSync(path.join(h.gameDir, "data"));
    await expect(h.deploy()).rejects.toThrow("Ambiguous deployment path");
    expect(nodeFs.readFileSync(path.join(h.modDir("SomeMod"), "DATA", "file.ini"), "utf8")).toBe(
      "mod",
    );
    nodeFs.rmdirSync(path.join(h.gameDir, "data"));
    const manifest = await h.deploy();
    expect(manifest[0].relPath).toBe(path.join("Data", "file.ini"));
  },
);

test("a legacy alias removed on a folded filesystem cannot delete the surviving output", async ({
  makeDeployment,
}) => {
  const h = makeDeployment({ files: { Foo: "mod" } });
  const first = await h.deploy();
  const legacy = [...first, { ...first[0], relPath: "foo" }];
  const manifest = await h.deployAll(["SomeMod"], legacy);
  expect(nodeFs.readFileSync(path.join(h.gameDir, "Foo"), "utf8")).toBe("mod");
  expect(manifest).toHaveLength(1);
});

caseSensitiveTest(
  "retains three target-case variants in a partial pass and cleans each in a full deployment",
  async ({ makeDeployment }) => {
    const h = makeDeployment({ files: { "Config.ini": "mod" } });
    const targets = ["MyMod", "MYMOD", "mymod"];
    const legacy = targets.map((target) => {
      nodeFs.mkdirSync(path.join(h.gameDir, target));
      nodeFs.linkSync(
        path.join(h.modDir("SomeMod"), "Config.ini"),
        path.join(h.gameDir, target, "Config.ini"),
      );
      return makeDeployedFile({ relPath: "Config.ini", target, source: "SomeMod" });
    });
    await h.method.prepare(h.gameDir, false, legacy, h.normalize);
    const partial = await h.method.finalize("skyrimse", h.gameDir, h.stagingDir);
    expect(partial).toHaveLength(3);
    await h.method.prepare(h.gameDir, true, partial, h.normalize);
    await h.method.activate(
      h.modDir("SomeMod"),
      "SomeMod",
      "MyMod",
      new BlacklistSet([], h.game, h.normalize),
    );
    const manifest = await h.method.finalize("skyrimse", h.gameDir, h.stagingDir);
    expect(manifest).toHaveLength(1);
    for (const target of targets)
      expect(nodeFs.existsSync(path.join(h.gameDir, target, "Config.ini"))).toBe(
        target === "MyMod",
      );
  },
);

for (const method of ["hardlink", "move"] as const) {
  test(
    method + ": removing a legacy alias retains the base backup through relink and purge",
    async ({ makeDeployment }) => {
      const h = makeDeployment({ method, files: { Foo: "mod" } });
      nodeFs.writeFileSync(path.join(h.gameDir, "Foo"), "base");
      const first = await h.deploy();
      const legacy = [...first, { ...first[0], relPath: "foo" }];
      const manifest = await h.deployAll(["SomeMod"], legacy);
      expect(manifest).toHaveLength(1);
      expect(nodeFs.readFileSync(path.join(h.gameDir, "Foo"), "utf8")).toBe("mod");
      expect(nodeFs.readFileSync(path.join(h.gameDir, "Foo.vortex_backup"), "utf8")).toBe("base");
      await h.method.purge(h.stagingDir, h.gameDir, "skyrimse");
      expect(nodeFs.readFileSync(path.join(h.gameDir, "Foo"), "utf8")).toBe("base");
      expect(nodeFs.readFileSync(path.join(h.modDir("SomeMod"), "Foo"), "utf8")).toBe("mod");
    },
  );
}

test.skipIf(process.platform !== "win32")(
  "whole-group removal finishes a delayed alias unlink before restoring the base",
  async ({ makeDeployment }) => {
    const h = makeDeployment({ files: { Foo: "mod" } });
    nodeFs.writeFileSync(path.join(h.gameDir, "Foo"), "base");
    const first = await h.deploy();
    const legacy = [...first, { ...first[0], relPath: "foo" }];
    // Keep physical IO real while making the dangerous ordering deterministic: one
    // alias unlink completes now, the other runs in the next event-loop turn.
    let calls = 0;
    const unlink = vi.spyOn(h.method as any, "unlinkFile").mockImplementation((output: string) => {
      const remove = () => nodeFs.rmSync(output, { force: true });
      if (++calls === 1) {
        remove();
        return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) =>
        setImmediate(() => {
          try {
            remove();
            resolve();
          } catch (err) {
            reject(err);
          }
        }),
      );
    });
    const rename = vi.spyOn(deploymentFs, "renameAsync").mockImplementation((from, to) => {
      try {
        nodeFs.renameSync(from, to);
        return Promise.resolve() as any;
      } catch (err) {
        return Promise.reject(err) as any;
      }
    });
    try {
      expect(await h.deployAll([], legacy)).toEqual([]);
      expect(calls).toBe(2);
      expect(nodeFs.readFileSync(path.join(h.gameDir, "Foo"), "utf8")).toBe("base");
      expect(nodeFs.existsSync(path.join(h.gameDir, "Foo.vortex_backup"))).toBe(false);
    } finally {
      unlink.mockRestore();
      rename.mockRestore();
    }
  },
);

for (const method of ["hardlink", "move"] as const) {
  caseSensitiveTest(
    method + ": partial disable removes all legacy variants owned by the source",
    async ({ makeDeployment }) => {
      const h = makeDeployment({
        method,
        files: { Foo: "upper", foo: "lower" },
        normalize: (input) => input,
      });
      const legacy = await h.deploy();
      expect(legacy).toHaveLength(2);
      await h.method.prepare(h.gameDir, false, legacy, (input) => input.toUpperCase());
      await h.method.deactivate(h.modDir("SomeMod"), "", "SomeMod");
      const manifest = await h.method.finalize("skyrimse", h.gameDir, h.stagingDir);
      expect(manifest).toEqual([]);
      for (const name of ["Foo", "foo"]) {
        expect(nodeFs.existsSync(path.join(h.gameDir, name))).toBe(false);
        expect(nodeFs.readFileSync(path.join(h.modDir("SomeMod"), name), "utf8")).toBe(
          name === "Foo" ? "upper" : "lower",
        );
      }
    },
  );
}

test("partial disable retains a different source under a variant key and holds the base backup", async ({
  makeDeployment,
}) => {
  const h = makeDeployment({
    files: { Foo: "disabled" },
    otherMods: { Other: { Foo: "survivor" } },
  });
  nodeFs.writeFileSync(path.join(h.gameDir, "Foo"), "base");
  const first = await h.deploy();
  if (process.platform === "win32") nodeFs.unlinkSync(path.join(h.gameDir, "Foo"));
  nodeFs.linkSync(path.join(h.modDir("Other"), "Foo"), path.join(h.gameDir, "foo"));
  const legacy = [
    ...first,
    makeDeployedFile({ relPath: "foo", sourceRelPath: "Foo", source: "Other" }),
  ];
  const manifest = await h.remove(legacy);
  expect(manifest.map((file) => file.source)).toEqual(["Other"]);
  expect(nodeFs.readFileSync(path.join(h.gameDir, "foo"), "utf8")).toBe("survivor");
  expect(nodeFs.readFileSync(path.join(h.gameDir, "Foo.vortex_backup"), "utf8")).toBe("base");
  await h.method.purge(h.stagingDir, h.gameDir, "skyrimse");
  expect(nodeFs.readFileSync(path.join(h.gameDir, "Foo"), "utf8")).toBe("base");
});

caseSensitiveTest(
  "whole-group removal restores every distinct physical base backup",
  async ({ makeDeployment }) => {
    const h = makeDeployment({
      files: { Foo: "upper", foo: "lower" },
      normalize: (input) => input,
    });
    nodeFs.writeFileSync(path.join(h.gameDir, "Foo"), "upper base");
    nodeFs.writeFileSync(path.join(h.gameDir, "foo"), "lower base");
    const legacy = await h.deploy();
    await h.method.prepare(h.gameDir, true, legacy, (input) => input.toUpperCase());
    expect(await h.method.finalize("skyrimse", h.gameDir, h.stagingDir)).toEqual([]);
    expect(nodeFs.readFileSync(path.join(h.gameDir, "Foo"), "utf8")).toBe("upper base");
    expect(nodeFs.readFileSync(path.join(h.gameDir, "foo"), "utf8")).toBe("lower base");
  },
);
