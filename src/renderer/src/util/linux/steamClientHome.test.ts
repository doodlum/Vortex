import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, expect, it } from "vitest";

import { findSteamClientHome } from "./steamClientHome";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "vortex-steam-home-")));
  roots.push(home);
  const snapHome = path.join(home, "snap", "steam", "common");
  const steam = path.join(snapHome, ".local", "share", "Steam");
  return { home, snapHome, steam };
}

async function clientLibrary(steam: string, client = "linux64") {
  const file = path.join(steam, client, "steamclient.so");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "client");
  return file;
}

async function sdkLink(home: string, file: string, sdk = "sdk64") {
  const link = path.join(home, ".steam", sdk, "steamclient.so");
  await fs.mkdir(path.dirname(link), { recursive: true });
  // Hardlinks exercise exact file identity without Windows file-symlink privileges.
  await fs.link(file, link);
}

it("finds Snap's home using the SDK file belonging to the selected Steam client", async () => {
  const h = await fixture();
  const file = await clientLibrary(h.steam);
  await sdkLink(h.snapHome, file);
  expect(await findSteamClientHome(h.steam, h.home)).toBe(h.snapHome);
});

it("keeps the normal host home when its SDK belongs to this Steam installation", async () => {
  const h = await fixture();
  const steam = path.join(h.home, ".local", "share", "Steam");
  await sdkLink(h.home, await clientLibrary(steam));
  expect(await findSteamClientHome(steam, h.home)).toBe(h.home);
});

it("does not select another client's SDK even when both files have the same contents", async () => {
  const h = await fixture();
  await sdkLink(h.home, await clientLibrary(path.join(h.home, "other-steam")));
  await sdkLink(h.snapHome, await clientLibrary(h.steam));
  expect(await findSteamClientHome(h.steam, h.home)).toBe(h.snapHome);
});

it("supports a client exposing only its 32-bit SDK", async () => {
  const h = await fixture();
  await sdkLink(h.snapHome, await clientLibrary(h.steam, "linux32"), "sdk32");
  expect(await findSteamClientHome(h.steam, h.home)).toBe(h.snapHome);
});

it("leaves the inherited home alone when no matching SDK is available", async () => {
  const h = await fixture();
  await clientLibrary(h.steam);
  expect(await findSteamClientHome(h.steam, h.home)).toBeUndefined();
});

it("accepts an uninitialized client without changing the home", async () => {
  const h = await fixture();
  expect(await findSteamClientHome(h.steam, h.home)).toBeUndefined();
});

it.each([
  ["linux64", "sdk64"],
  ["linux32", "sdk32"],
])("finds a private home through a Steam directory alias with %s", async (client, sdk) => {
  const h = await fixture();
  await sdkLink(h.snapHome, await clientLibrary(h.steam, client), sdk);
  const alias = path.join(h.home, ".steam", "debian-installation");
  await fs.mkdir(path.dirname(alias), { recursive: true });
  await fs.symlink(h.steam, alias, process.platform === "win32" ? "junction" : "dir");
  expect(await findSteamClientHome(alias, h.home)).toBe(h.snapHome);
});
