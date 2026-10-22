import { createHash } from "node:crypto";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect } from "vitest";

import type { IDeploymentHarness, DeploymentMethodName } from "../../test-utils/deploymentTest";
import { test } from "../../test-utils/deploymentTest";
import { getGame } from "../gamemode_management/util/getGame";
import type { IDeployedFile } from "./types/IDeploymentMethod";
import BlacklistSet from "./util/BlacklistSet";
import { getDeploymentNormalizeFunc } from "./util/deploymentNormalize";

const reports: Record<string, unknown> = {};
const slash = (value: string): string => value.split(path.sep).join("/");
const digest = (file: string): string =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function filesUnder(root: string): string[] {
  const result: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const relative = entry.name;
    const absolute = path.join(root, relative);
    if (entry.isDirectory())
      result.push(...filesUnder(absolute).map((nested) => path.join(relative, nested)));
    else if (!entry.name.includes("folder_managed_by_vortex") && entry.name !== "__delete_if_empty")
      result.push(relative);
  }
  return result.sort();
}

function snapshot(harness: IDeploymentHarness, manifest: IDeployedFile[]) {
  const paths = filesUnder(harness.gameDir);
  return {
    files: paths
      .map((relative) => ({
        path: slash(relative),
        sha256: digest(path.join(harness.gameDir, relative)),
      }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    manifest: manifest
      .map((entry) => ({
        source: entry.source,
        stagingPath: slash(entry.sourceRelPath ?? entry.relPath),
        path: slash(path.join(entry.target ?? "", entry.relPath)),
      }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  };
}

afterAll(() => {
  const report = process.env.VORTEX_DEPLOYMENT_PARITY_REPORT;
  if (report === undefined) return;
  fs.mkdirSync(path.dirname(report), { recursive: true });
  fs.writeFileSync(
    report,
    JSON.stringify(
      Object.fromEntries(
        Object.entries(reports).sort(([left], [right]) => left.localeCompare(right)),
      ),
      null,
      2,
    ),
  );
});

// Unelevated Windows without Developer Mode cannot create file symlinks (EPERM).
function canCreateFileSymlinks(): boolean {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "vortex-symlink-probe-"));
  try {
    fs.writeFileSync(path.join(dir, "target"), "");
    fs.symlinkSync(path.join(dir, "target"), path.join(dir, "link"), "file");
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const symlinksUnavailable = !canCreateFileSymlinks();

for (const method of ["hardlink", "symlink", "move"] as DeploymentMethodName[]) {
  test.skipIf(method === "symlink" && symlinksUnavailable)(
    `${method}: case conflicts preserve base backups and staged sources through disable, re-enable and purge`,
    async ({ makeDeployment }) => {
      const gameId = `parity-${method}`;
      const h = makeDeployment({
        gameId,
        method,
        files: { "Config/Settings.ini": "A" },
        otherMods: { Other: { "config/settings.ini": "B" } },
      });
      fs.mkdirSync(path.join(h.gameDir, "Config"));
      fs.writeFileSync(path.join(h.gameDir, "Config", "Settings.ini"), "base");
      fs.writeFileSync(path.join(h.gameDir, "untouched.txt"), "unowned");
      const normalize = await getDeploymentNormalizeFunc(h.api.getState(), gameId, h.gameDir);
      const blacklist = new BlacklistSet([], h.game, normalize);
      const deploy = async (mods: string[], previous: IDeployedFile[] = [], clean = true) => {
        await h.method.prepare(h.gameDir, clean, previous, normalize);
        for (const mod of mods) await h.method.activate(h.modDir(mod), mod, "", blacklist);
        return h.method.finalize(gameId, h.gameDir, h.stagingDir);
      };
      const phases: unknown[] = [];
      const assertWinner = (value: string) => {
        const outputs = filesUnder(h.gameDir).filter(
          (relative) => slash(relative).toLowerCase() === "config/settings.ini",
        );
        expect(outputs.map(slash)).toEqual(["Config/Settings.ini"]);
        expect(fs.readFileSync(path.join(h.gameDir, outputs[0]), "utf8")).toBe(value);
        const backups = filesUnder(h.gameDir).filter(
          (relative) => slash(relative).toLowerCase() === "config/settings.ini.vortex_backup",
        );
        expect(backups.map(slash)).toEqual(["Config/Settings.ini.vortex_backup"]);
        expect(fs.readFileSync(path.join(h.gameDir, backups[0]), "utf8")).toBe("base");
      };
      let manifest = await deploy(["SomeMod"]);
      assertWinner("A");
      phases.push(snapshot(h, manifest));
      manifest = await deploy(["Other"], manifest, false);
      assertWinner("B");
      phases.push(snapshot(h, manifest));
      expect(await h.method.externalChanges(gameId, h.stagingDir, h.gameDir, manifest)).toEqual([]);
      manifest = await deploy(["SomeMod"], manifest);
      assertWinner("A");
      phases.push(snapshot(h, manifest));
      manifest = await deploy(["SomeMod", "Other"], manifest);
      assertWinner("B");
      phases.push(snapshot(h, manifest));
      await h.method.purge(h.stagingDir, h.gameDir, gameId);
      const restored = filesUnder(h.gameDir).filter(
        (relative) => slash(relative).toLowerCase() === "config/settings.ini",
      );
      expect(restored.map(slash)).toEqual(["Config/Settings.ini"]);
      expect(fs.readFileSync(path.join(h.gameDir, restored[0]), "utf8")).toBe("base");
      expect(fs.readFileSync(path.join(h.gameDir, "untouched.txt"), "utf8")).toBe("unowned");
      expect(
        fs.readFileSync(path.join(h.modDir("SomeMod"), "Config", "Settings.ini"), "utf8"),
      ).toBe("A");
      expect(fs.readFileSync(path.join(h.modDir("Other"), "config", "settings.ini"), "utf8")).toBe(
        "B",
      );
      phases.push(snapshot(h, []));
      reports[method] = phases;
    },
  );
}

test.skipIf(process.platform !== "linux")(
  "native games retain distinct Foo and foo through production normalization",
  async ({ makeDeployment }) => {
    const gameId = "parity-native";
    const h = makeDeployment({ gameId, files: { Foo: "upper", foo: "lower" } });
    getGame(gameId).executable = () => "native-game";
    const normalize = await getDeploymentNormalizeFunc(h.api.getState(), gameId, h.gameDir);
    expect(normalize("Foo")).not.toBe(normalize("foo"));
    await h.method.prepare(h.gameDir, true, [], normalize);
    await h.method.activate(
      h.modDir("SomeMod"),
      "SomeMod",
      "",
      new BlacklistSet([], h.game, normalize),
    );
    const manifest = await h.method.finalize(gameId, h.gameDir, h.stagingDir);
    expect(manifest).toHaveLength(2);
    expect(fs.readFileSync(path.join(h.gameDir, "Foo"), "utf8")).toBe("upper");
    expect(fs.readFileSync(path.join(h.gameDir, "foo"), "utf8")).toBe("lower");
  },
);

test("hardlink: a mod subfolder keeps canonical output and restores its base file", async ({
  makeDeployment,
}) => {
  const h = makeDeployment({ files: { "config/settings.ini": "mod" }, modFolders: true });
  const destination = path.join(h.gameDir, "somemod", "Config", "Settings.ini");
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, "base");
  const manifest = await h.deploy();
  expect(manifest[0]).toMatchObject({
    target: "somemod",
    relPath: path.join("Config", "Settings.ini"),
    sourceRelPath: path.join("config", "settings.ini"),
  });
  expect(await h.method.externalChanges("skyrimse", h.stagingDir, h.gameDir, manifest)).toEqual([]);
  expect(fs.readFileSync(destination, "utf8")).toBe("mod");
  const phases = [snapshot(h, manifest)];
  await h.remove(manifest);
  expect(fs.readFileSync(destination, "utf8")).toBe("base");
  expect(fs.readFileSync(path.join(h.modDir("SomeMod"), "config", "settings.ini"), "utf8")).toBe(
    "mod",
  );
  phases.push(snapshot(h, []));
  reports["hardlink-subfolder"] = phases;
});
