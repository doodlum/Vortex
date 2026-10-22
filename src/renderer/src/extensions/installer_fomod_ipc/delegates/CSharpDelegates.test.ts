import * as nodeFs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import IniParser from "@nexusmods/ini-parser";
import { afterEach, beforeEach, expect, vi } from "vitest";

import { registerHarnessGame } from "../../../test-utils/builders";
import { test } from "../../../test-utils/harnessTest";
import { CSharpDelegates } from "./CSharpDelegates";

const fixture = vi.hoisted(() => ({ file: "" }));
vi.mock("../../installer_fomod_shared/utils/gameSupport", () => ({
  getIniFilePath: () => fixture.file,
}));
vi.mock("../../gamemode_management/selectors", () => ({
  currentGame: () => ({ id: "skyrimse" }),
  currentGameDiscovery: () => undefined,
}));

let directory: string;
beforeEach(async () => {
  directory = await nodeFs.mkdtemp(path.join(os.tmpdir(), "vortex-ini-delegate-"));
  fixture.file = path.join(directory, "Config.ini");
  await nodeFs.writeFile(fixture.file, "[General]\r\nName=example\r\nCount=42\r\n");
  registerHarnessGame("skyrimse");
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await nodeFs.rm(directory, { recursive: true, force: true });
});

test("FOMOD INI delegates read a real string and integer through the selected backend", async ({
  makeApi,
}) => {
  const { api } = makeApi();
  const delegates = new CSharpDelegates(api);
  expect(await delegates.getIniString("", "General", "Name")).toBe("example");
  expect(await delegates.getIniInt("", "General", "Count")).toBe(42);
});

test("FOMOD selected INI filenames resolve Windows separators and physical case", async ({
  makeApi,
}) => {
  vi.stubGlobal("process", { ...process, platform: "linux" });
  const physical = path.join(directory, "SETTINGS", "SKYRIMPREFS.INI");
  await nodeFs.mkdir(path.dirname(physical), { recursive: true });
  await nodeFs.writeFile(physical, "[General]\nName=choice\nCount=17\n");
  const read = vi.spyOn(IniParser.prototype, "read");
  const { api } = makeApi();
  const delegates = new CSharpDelegates(api);
  expect(await delegates.getIniString("Settings\\SkyrimPrefs.ini", "General", "Name")).toBe(
    "choice",
  );
  expect(await delegates.getIniInt("Settings\\SkyrimPrefs.ini", "General", "Count")).toBe(17);
  expect(read).toHaveBeenCalledWith(physical);
});
