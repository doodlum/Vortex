import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, it, vi } from "vitest";

vi.mock("@nexusmods/vortex-api", async () => {
  const fs = await import("node:fs/promises");
  return {
    fs: { readFileAsync: fs.readFile },
    selectors: { activeGameId: () => "stardewvalley" },
    log: vi.fn(),
    util: { deBOM: (text: string) => text.replace(/^\uFEFF/, "") },
  };
});
import { createManifestAttributeExtractor } from "./createManifestAttributeExtractor";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith("sdv-manifest-name-"));
    await rm(root, { recursive: true, force: true });
  }
});
async function fixture(files: string[] = []) {
  const root = await mkdtemp(path.join(os.tmpdir(), "sdv-manifest-name-"));
  roots.push(root);
  const directory = path.join(root, "Mods", "ConsoleCommands");
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "manifest.json"),
    JSON.stringify({
      Name: "Console Commands",
      UniqueID: "SMAPI.ConsoleCommands",
      Version: "4.5.2",
      MinimumApiVersion: "4.5.2",
    }),
  );
  for (const file of files) await writeFile(path.join(root, file), "inert loader fixture");
  const context = { api: { getState: () => ({}) } } as any;
  return { root, extract: createManifestAttributeExtractor(context) };
}
it.each(["StardewModdingAPI", "StardewModdingAPI.exe"])(
  "keeps a local SMAPI loader package name with %s and no Nexus download metadata",
  async (executable) => {
    const f = await fixture(["StardewModdingAPI.dll", executable]);
    const result = await f.extract({ download: {} }, f.root);
    expect(result.customFileName).toBeUndefined();
    expect(result.manifestVersion).toBe("4.5.2");
    expect(result.additionalLogicalFileNames).toEqual(["smapi.consolecommands"]);
  },
);
it("keeps the manifest name for an ordinary mod", async () => {
  const f = await fixture();
  expect((await f.extract({ download: {} }, f.root)).customFileName).toBe("Console Commands");
});
it.each(["StardewModdingAPI.dll", "StardewModdingAPI.exe"])(
  "retains ordinary manifest naming when %s is the only loader-looking file",
  async (file) => {
    const f = await fixture([file]);
    expect((await f.extract({ download: {} }, f.root)).customFileName).toBe("Console Commands");
  },
);
it.each([2400, "2400"])("preserves Nexus SMAPI identity %s", async (modId) => {
  const f = await fixture();
  const result = await f.extract({ download: { modInfo: { nexus: { ids: { modId } } } } }, f.root);
  expect(result.customFileName).toBeUndefined();
});
it.each([
  { files: ["StardewModdingAPI.exe"], directory: "StardewModdingAPI.dll" },
  { files: ["StardewModdingAPI.dll"], directory: "StardewModdingAPI" },
])("keeps ordinary naming when $directory is a directory", async ({ files, directory }) => {
  const f = await fixture(files);
  await mkdir(path.join(f.root, directory));
  expect((await f.extract({ download: {} }, f.root)).customFileName).toBe("Console Commands");
});
