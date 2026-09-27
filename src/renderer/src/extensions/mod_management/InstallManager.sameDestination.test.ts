import * as nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type * as FsModule from "../../util/fs";
import InstallManager from "./InstallManager";

// Links of the first variant finish late, as they can when the disk is busy. Without the fix the
// late link then hits EEXIST, replaces the later instruction's file and wins.
vi.mock("../../util/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>();
  return {
    ...actual,
    linkAsync: async (src: string, dst: string, ...rest: unknown[]) => {
      if (/[\\/]Main[\\/]/.test(src)) {
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      return (actual.linkAsync as any)(src, dst, ...rest);
    },
  };
});

// extractArchive links an install's files in parallel. When an installer produces two
// instructions for one destination (the Nanosuit FOMOD installs a main and an optional variant of
// the same texture), the deployed file used to be whichever link finished last. The last
// instruction now always wins.
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    nodeFs.rmSync(root, { recursive: true, force: true });
  }
});

async function install(copies: Array<{ source: string; destination: string }>) {
  const root = nodeFs.mkdtempSync(path.join(os.tmpdir(), "vortex-same-dest-"));
  roots.push(root);
  const temp = path.join(root, "mod.installing");
  const dest = path.join(root, "mod");
  for (const variant of ["Main", "White", "Red"]) {
    nodeFs.mkdirSync(path.join(temp, variant, "Textures"), { recursive: true });
    for (let i = 0; i < 20; ++i) {
      nodeFs.writeFileSync(path.join(temp, variant, "Textures", `glow${i}.dds`), variant);
    }
  }
  const api = { showErrorNotification: () => undefined, translate: (s: string) => s };
  await (InstallManager.prototype as any).extractArchive.call(
    {},
    api,
    "archive.7z",
    temp,
    dest,
    copies.map((c) => ({ type: "copy", ...c })),
    "fallout4",
  );
  return (i: number) => nodeFs.readFileSync(path.join(dest, "Textures", `glow${i}.dds`), "utf8");
}

describe("several instructions for one destination", () => {
  it("installs the file of the last instruction, every time", async () => {
    for (let round = 0; round < 5; ++round) {
      const copies = [];
      for (let i = 0; i < 20; ++i) {
        copies.push({
          source: `Main\\Textures\\glow${i}.dds`,
          destination: `Textures\\glow${i}.dds`,
        });
      }
      for (let i = 0; i < 20; ++i) {
        copies.push({
          source: `White\\Textures\\glow${i}.dds`,
          destination: `textures\\GLOW${i}.dds`,
        });
      }
      const read = await install(copies);
      for (let i = 0; i < 20; ++i) {
        expect(read(i)).toBe("White");
      }
    }
  });

  it("follows the instruction order, not the variant name", async () => {
    const read = await install([
      { source: "White\\Textures\\glow0.dds", destination: "Textures\\glow0.dds" },
      { source: "Red\\Textures\\glow0.dds", destination: "Textures\\glow0.dds" },
      { source: "Main\\Textures\\glow0.dds", destination: "Textures\\glow0.dds" },
    ]);
    expect(read(0)).toBe("Main");
  });
});
