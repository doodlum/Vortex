import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, expect, test, vi } from "vitest";

const volume = vi.hoisted(() => ({ root: "" }));
vi.mock("../../../util/getVolumePath", () => ({ getVolumePath: () => volume.root }));

import { stagingVolume } from "./discovery";

let directory: string;
let library: string;
let game: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "vortex-staging-volume-"));
  // A root-owned mount point holding a user-owned Steam library.
  volume.root = path.join(directory, "mnt-games");
  library = path.join(volume.root, "SteamLibrary");
  game = path.join(library, "steamapps", "common", "Skyrim Special Edition");
  await fs.mkdir(path.join(game, "Data"), { recursive: true });
  await fs.chmod(volume.root, 0o555);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await fs.chmod(volume.root, 0o755);
  await fs.rm(directory, { recursive: true, force: true });
});

test.skipIf(process.platform === "win32")(
  "a read-only Linux mount point suggests the highest writable folder outside the game",
  async () => {
    expect(await stagingVolume(path.join(game, "Data"), game)).toBe(library);
  },
);

test.skipIf(process.platform === "win32")(
  "a mod path that does not exist yet is resolved from its nearest existing folder",
  async () => {
    expect(await stagingVolume(path.join(game, "Data", "Missing", "Deeper"), game)).toBe(library);
  },
);

test.skipIf(process.platform === "win32")(
  "without any writable folder outside the game the mount point is kept",
  async () => {
    await fs.chmod(library, 0o555);
    await fs.chmod(path.join(library, "steamapps"), 0o555);
    await fs.chmod(path.join(library, "steamapps", "common"), 0o555);
    try {
      expect(await stagingVolume(path.join(game, "Data"), game)).toBe(volume.root);
    } finally {
      await fs.chmod(path.join(library, "steamapps", "common"), 0o755);
      await fs.chmod(path.join(library, "steamapps"), 0o755);
      await fs.chmod(library, 0o755);
    }
  },
);

test("Windows keeps the drive root", async () => {
  vi.stubGlobal("process", { ...process, platform: "win32" });
  expect(await stagingVolume(path.join(game, "Data"), game)).toBe(volume.root);
});
