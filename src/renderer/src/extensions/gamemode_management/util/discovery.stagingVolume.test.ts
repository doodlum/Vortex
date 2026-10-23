import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, expect, test, vi } from "vitest";

import type * as VolumeModule from "../../../util/getVolumePath";

const volume = vi.hoisted(() => ({ root: "", actual: false }));
vi.mock("../../../util/getVolumePath", async (importOriginal) => {
  const original = await importOriginal<typeof VolumeModule>();
  return {
    getVolumePath: (input: string) => (volume.actual ? original.getVolumePath(input) : volume.root),
  };
});

import { stagingVolume, suggestStagingPathFromPaths } from "./discovery";

let directory: string;
let library: string;
let game: string;
beforeEach(async () => {
  volume.actual = false;
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "vortex-staging-volume-"));
  // A root-owned mount point holding a user-owned Steam library.
  volume.root = path.join(directory, "mnt-games");
  library = path.join(volume.root, "SteamLibrary");
  game = path.join(library, "steamapps", "common", "Skyrim Special Edition");
  await fs.mkdir(path.join(game, "Data"), { recursive: true });
  await fs.chmod(volume.root, 0o555);
});

test.runIf(process.platform === "linux")(
  "a game symlink into another filesystem suggests staging outside the physical game",
  async (context) => {
    let target: string;
    try {
      if ((await fs.stat("/dev/shm")).dev === (await fs.stat(directory)).dev) {
        context.skip();
        return;
      }
      target = await fs.mkdtemp("/dev/shm/vortex-staging-game-");
    } catch {
      context.skip();
      return;
    }
    try {
      const physicalGame = path.join(target, "Game");
      await fs.mkdir(path.join(physicalGame, "Data"), { recursive: true });
      const linkedGame = path.join(directory, "LinkedGame");
      await fs.symlink(physicalGame, linkedGame);
      volume.actual = true;
      expect(await stagingVolume(path.join(linkedGame, "Data"), linkedGame)).toBe("/dev/shm");
      expect(await stagingVolume(path.join(linkedGame, "Data", "Missing"), physicalGame)).toBe(
        "/dev/shm",
      );
      expect(
        await suggestStagingPathFromPaths(
          path.join(linkedGame, "Data"),
          linkedGame,
          directory,
          "Vortex Mods",
        ),
      ).toBe(path.join("/dev/shm", "Vortex Mods", "{game}"));
    } finally {
      await fs.rm(target, { recursive: true, force: true });
    }
  },
);
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
  "without any writable folder outside the game an unusable suggestion is refused",
  async () => {
    await fs.chmod(library, 0o555);
    await fs.chmod(path.join(library, "steamapps"), 0o555);
    await fs.chmod(path.join(library, "steamapps", "common"), 0o555);
    try {
      await expect(stagingVolume(path.join(game, "Data"), game)).rejects.toThrow(
        "No writable staging folder",
      );
      const dotPrefixedMods = path.join(game, "..mods", "Data");
      await fs.mkdir(dotPrefixedMods, { recursive: true });
      await expect(stagingVolume(dotPrefixedMods, game)).rejects.toThrow(
        "No writable staging folder",
      );
    } finally {
      await fs.chmod(path.join(library, "steamapps", "common"), 0o755);
      await fs.chmod(path.join(library, "steamapps"), 0o755);
      await fs.chmod(library, 0o755);
    }
  },
);

test.runIf(process.platform === "linux")(
  "a game occupying the entire filesystem has no outside staging folder",
  async () => {
    await expect(stagingVolume(path.join(game, "Data"), volume.root)).rejects.toThrow(
      "No writable staging folder",
    );
  },
);

test("Windows keeps the drive root", async () => {
  vi.stubGlobal("process", { ...process, platform: "win32" });
  expect(await stagingVolume(path.join(game, "Data"), game)).toBe(volume.root);
});

test.runIf(process.platform === "linux")(
  "a symlink loop is not treated as a missing mod directory",
  async () => {
    const loop = path.join(directory, "loop");
    await fs.symlink("loop", loop);
    await expect(stagingVolume(path.join(loop, "Data"), loop)).rejects.toMatchObject({
      code: "ELOOP",
    });
    await expect(
      suggestStagingPathFromPaths(path.join(loop, "Data"), loop, directory, "mods"),
    ).rejects.toMatchObject({ code: "ELOOP" });
  },
);

test.runIf(process.platform === "linux" && process.getuid?.() !== 0)(
  "an inaccessible mod directory is not replaced by a writable ancestor",
  async () => {
    const locked = path.join(directory, "locked");
    const lockedGame = path.join(locked, "Game");
    await fs.mkdir(path.join(lockedGame, "Data"), { recursive: true });
    await fs.chmod(locked, 0o000);
    try {
      await expect(stagingVolume(path.join(lockedGame, "Data"), lockedGame)).rejects.toMatchObject({
        code: "EACCES",
      });
      await expect(
        suggestStagingPathFromPaths(path.join(lockedGame, "Data"), lockedGame, directory, "mods"),
      ).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      await fs.chmod(locked, 0o700);
    }
  },
);

test.runIf(process.platform === "linux")(
  "same-device user data is valid even when game ancestors are not writable",
  async () => {
    await fs.chmod(library, 0o555);
    await fs.chmod(path.join(library, "steamapps"), 0o555);
    await fs.chmod(path.join(library, "steamapps", "common"), 0o555);
    try {
      const userData = path.join(volume.root, "user-data");
      await fs.chmod(volume.root, 0o755);
      await fs.mkdir(userData);
      await fs.chmod(volume.root, 0o555);
      expect(
        await suggestStagingPathFromPaths(
          path.join(game, "Data", "Missing"),
          game,
          userData,
          "mods",
        ),
      ).toBe(path.join("{USERDATA}", "{game}", "mods"));
    } finally {
      await fs.chmod(path.join(library, "steamapps", "common"), 0o755);
      await fs.chmod(path.join(library, "steamapps"), 0o755);
      await fs.chmod(library, 0o755);
    }
  },
);
