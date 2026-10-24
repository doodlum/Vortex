import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vortex-vfs-arch-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
const aetherDir = path.join(dir, "aether");

vi.mock("./aether", () => ({
  aetherLoadError: () => undefined,
  loadAether: () => ({ dir: aetherDir }),
}));
vi.mock("../gamemode_management/util/getGame", () => ({
  getGame: () => ({ executable: () => "x86.exe" }),
}));

import type { IState } from "../../types/IState";
import { imageArch, vfsSupport } from "./support";

/** A minimal PE image: the DOS header pointing at a PE signature and machine field. */
function writeImage(name: string, machine: number): string {
  const image = Buffer.alloc(0x200);
  image.write("MZ", 0, "latin1");
  image.writeUInt32LE(0x80, 0x3c);
  image.write("PE\0\0", 0x80, "latin1");
  image.writeUInt16LE(machine, 0x84);
  const file = path.join(dir, name);
  fs.writeFileSync(file, image);
  return file;
}

describe("imageArch", () => {
  it("reads the machine a Windows executable is built for", () => {
    expect(imageArch(writeImage("x64.exe", 0x8664))).toBe("x64");
    expect(imageArch(writeImage("x86.exe", 0x14c))).toBe("x86");
    expect(imageArch(writeImage("arm.exe", 0xaa64))).toBe("other");
  });

  it("is undefined for a missing file or one that is not a PE image", () => {
    expect(imageArch(path.join(dir, "missing.exe"))).toBeUndefined();
    const text = path.join(dir, "game.sh");
    fs.writeFileSync(text, "#!/bin/sh\nexec ./game\n");
    expect(imageArch(text)).toBeUndefined();
  });

  it("rereads a file that changed", () => {
    const file = writeImage("changes.exe", 0x14c);
    expect(imageArch(file)).toBe("x86");
    const later = new Date(Date.now() + 5000);
    writeImage("changes.exe", 0x8664);
    fs.utimesSync(file, later, later);
    expect(imageArch(file)).toBe("x64");
  });
});

describe.runIf(process.platform === "win32")("a 32-bit game", () => {
  const state = {
    settings: { gameMode: { discovered: { old: { path: dir } } } },
  } as unknown as IState;

  it("is served once the 32-bit shim is installed", () => {
    writeImage("x86.exe", 0x14c);
    expect(vfsSupport(state, "old")?.description((s: string) => s)).toBe(
      "The virtual file system's 32-bit files are missing.",
    );
    fs.mkdirSync(path.join(aetherDir, "x86"), { recursive: true });
    fs.writeFileSync(path.join(aetherDir, "x86", "vfs_shim_dll.dll"), "");
    expect(vfsSupport(state, "old")).toBeUndefined();
  });
});
