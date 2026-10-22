import * as nodeFs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, expect, vi } from "vitest";

import { makeMod, makeProfile } from "../../test-utils/builders";
import { test } from "../../test-utils/harnessTest";
import type { IExtensionContext } from "../../types/IExtensionContext";
import { INI_TWEAKS_PATH } from "../mod_management/InstallManager";
import init from "./index";

const fixture = vi.hoisted(() => ({ file: "" }));
vi.mock("./gameSupport", () => ({ iniFiles: () => [fixture.file], iniFormat: () => "winapi" }));
vi.mock("./TweakList", () => ({ default: () => null }));

let directory: string;
const original = "; base comment\r\n[General]\r\nSetting=base\r\nKeep=original\r\n";
beforeEach(async () => {
  directory = await nodeFs.mkdtemp(path.join(os.tmpdir(), "vortex-ini-bake-"));
  fixture.file = path.join(directory, "Config.ini");
  for (const suffix of ["", ".base", ".baked"])
    await nodeFs.writeFile(fixture.file + suffix, original);
});
afterEach(async () => {
  await nodeFs.rm(directory, { recursive: true, force: true });
});

for (const tweakName of ["Mixed[Config].ini", "Config.ini"]) {
  test("bakes " + tweakName + " and preserves base/manual edits", async ({ makeApi }) => {
    const staging = path.join(directory, "staging");
    const h = makeApi({
      discovered: { skyrimse: { path: directory } },
      installPath: { skyrimse: staging },
    });
    const mod = makeMod({ installationPath: "SomeMod", enabledINITweaks: [tweakName] });
    const tweaks = path.join(staging, "SomeMod", INI_TWEAKS_PATH);
    await nodeFs.mkdir(tweaks, { recursive: true });
    await nodeFs.writeFile(path.join(tweaks, tweakName), "[General]\r\nSetting=mod\r\n");
    init({
      api: h.api,
      once: (callback: () => void) => callback(),
      registerTest: vi.fn(),
      registerTableAttribute: vi.fn(),
    } as unknown as IExtensionContext);
    const profile = makeProfile();
    await h.emitAndAwait("bake-settings", "skyrimse", [mod], profile);
    expect(h.errorNotifications).toEqual([]);
    const baked = await nodeFs.readFile(fixture.file, "utf8");
    expect(baked).toContain("Setting=mod");
    expect(baked).toContain("; base comment");
    expect(baked).toContain("Keep=original");
    expect(await nodeFs.readFile(fixture.file + ".base", "utf8")).toBe(original);
    expect(await nodeFs.readFile(fixture.file + ".baked", "utf8")).toBe(baked);

    await nodeFs.writeFile(fixture.file, baked.replace("Setting=mod", "Setting=user"));
    await h.emitAndAwait("bake-settings", "skyrimse", [], profile);
    expect(h.errorNotifications).toEqual([]);
    expect(await nodeFs.readFile(fixture.file, "utf8")).toContain("Setting=user");
    expect(await nodeFs.readFile(fixture.file + ".base", "utf8")).toContain("Setting=user");
  });
}
