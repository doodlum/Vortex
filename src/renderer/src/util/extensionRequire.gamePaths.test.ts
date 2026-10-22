import * as fs from "node:fs";
import * as disk from "node:fs/promises";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";

import { VortexGameId } from "@vortex/shared";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { extensionRequire } from "./extensionRequire";
import { gameUserPathNamespace, withGameUserPaths } from "./gameUserContext";

const fixture = vi.hoisted(() => ({
  roots: {} as Record<string, string>,
  base: "",
  prefix: "",
  open: vi.fn(),
  games: [] as any[],
  discoveries: {} as Record<string, any>,
}));
vi.mock("../api", async () => ({
  fs: createRequire(__filename)("node:fs"),
  util: {
    getVortexPath: (name: string) => fixture.roots[name],
    opn: fixture.open,
  },
}));
vi.mock("../controls/ReactSelectWrap", () => ({}));
vi.mock("../ExtensionManager", () => ({
  default: { getExtensionPaths: () => [{ path: fixture.base }] },
}));
vi.mock("../extensions/extension_manager/queries", () => ({ findInstalled: () => undefined }));
vi.mock("./deprecatedApiUsage", () => ({
  deprecatedApiGet: (target: object, key: string) => Reflect.get(target, key),
}));
vi.mock("./webpack-hacks", () => ({ webpackRequireHack: () => undefined }));
vi.mock("../extensions/gamemode_management/util/gameRegistry", () => ({
  getGameDefinition: (id: string) =>
    fixture.games.find((game) => game.id === id) ?? { executable: () => "game.exe" },
  getGameStoresSafe: () => [],
  getRegisteredGameDefinitions: () => fixture.games,
  getGameDiscovery: (id: string) => fixture.discoveries[id],
}));
vi.mock("./getVortexPath", () => ({ default: (name: string) => fixture.roots[name] }));
vi.mock("./storeLookup", () => ({
  findGameEntry: () => ({ usesProton: true, compatDataPath: fixture.prefix }),
}));

const originalProcess = process;
const nativeRequire = createRequire(__filename);
let directory: string;
let parent: { filename: string };
let load: (id: string) => any;
let discovered: { path: string; store: string };
let user: string;
let serial = 0;
const owned = <T>(callback: () => T): T =>
  withGameUserPaths(VortexGameId("loader-fixture"), discovered, callback);

beforeEach(async () => {
  directory = await disk.mkdtemp(path.join(os.tmpdir(), "vortex-extension-game-paths-"));
  fixture.base = path.join(directory, "plugins");
  const extensionRoot = path.join(fixture.base, "game-fixture");
  parent = { filename: path.join(extensionRoot, "submodule", "index.js") };
  const extension = { path: extensionRoot, name: "fixture-" + serial++, namespace: "fixture" };
  load = extensionRequire(
    function (id: string) {
      return nativeRequire(id);
    },
    () => [extension] as any,
    () => ({}),
  );
  fixture.roots = {
    documents: path.join(directory, "host", "Documents"),
    appData: path.join(directory, "host", "Roaming"),
    localAppData: path.join(directory, "host", "Local"),
  };
  fixture.roots.userData = path.join(fixture.roots.appData, "Vortex");
  fixture.prefix = path.join(directory, "compatdata", "42");
  user = path.join(fixture.prefix, "pfx", "drive_c", "users", "steamuser");
  await disk.mkdir(user, { recursive: true });
  await disk.writeFile(path.join(fixture.prefix, "pfx", "system.reg"), "WINE REGISTRY Version 2\n");
  await disk.mkdir(fixture.roots.documents, { recursive: true });
  await disk.writeFile(path.join(fixture.roots.documents, "saved.txt"), "host sentinel");
  discovered = { path: path.join(directory, "game"), store: "steam" };
  fixture.open.mockReset();
  fixture.games = [];
  fixture.discoveries = {};
  vi.stubGlobal("process", { ...originalProcess, platform: "linux" });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await disk.rm(directory, { recursive: true, force: true });
});

test.each(["fs", "node:fs", "fs-extra"])(
  "registered extension %s calls use its prefix",
  async (id) => {
    const adapted = load.call(parent, id);
    const destination = path.join(fixture.roots.documents, "saved.txt");
    owned(() => {
      adapted.mkdirSync(fixture.roots.documents, { recursive: true });
      adapted.writeFileSync(destination, "game file");
      expect(adapted.readFileSync(destination, "utf8")).toBe("game file");
      expect(adapted.realpathSync.native(destination)).toBe(
        fs.realpathSync.native(path.join(user, "Documents", "saved.txt")),
      );
    });
    expect(await disk.readFile(destination, "utf8")).toBe("host sentinel");
    expect(await disk.readFile(path.join(user, "Documents", "saved.txt"), "utf8")).toBe(
      "game file",
    );
  },
);

test.each(["fs/promises", "node:fs/promises"])(
  "registered extension %s async calls use its prefix",
  async (id) => {
    const adapted = load.call(parent, id);
    await owned(async () => {
      await adapted.mkdir(fixture.roots.documents, { recursive: true });
      await adapted.writeFile(path.join(fixture.roots.documents, "saved.txt"), "async game file");
    });
    expect(await disk.readFile(path.join(user, "Documents", "saved.txt"), "utf8")).toBe(
      "async game file",
    );
    expect(await disk.readFile(path.join(fixture.roots.documents, "saved.txt"), "utf8")).toBe(
      "host sentinel",
    );
  },
);

test("cached Node module namespaces and descriptor-based fs clones retain adaptation", async () => {
  const adapted = load.call(parent, "fs");
  expect(load.call(parent, "fs")).toBe(adapted);
  expect(load.call(parent, "node:fs")).toBe(adapted);
  expect(adapted.promises).toBe(load.call(parent, "fs/promises"));
  const cloned = Object.create(
    Object.getPrototypeOf(adapted),
    Object.getOwnPropertyDescriptors(adapted),
  );
  owned(() => {
    cloned.mkdirSync(fixture.roots.documents, { recursive: true });
    cloned.writeFileSync(path.join(fixture.roots.documents, "saved.txt"), "clone game file");
  });
  expect(await disk.readFile(path.join(user, "Documents", "saved.txt"), "utf8")).toBe(
    "clone game file",
  );
  expect(await disk.readFile(path.join(fixture.roots.documents, "saved.txt"), "utf8")).toBe(
    "host sentinel",
  );
});

test("streams and read constructors retain Node behavior inside the game context", async () => {
  const adapted = load.call(parent, "node:fs");
  await owned(async () => {
    await adapted.promises.mkdir(fixture.roots.documents, { recursive: true });
    await new Promise<void>((resolve, reject) => {
      const output = adapted.createWriteStream(path.join(fixture.roots.documents, "stream.txt"));
      output.on("error", reject).on("finish", resolve);
      output.end("streamed game file");
    });
    const input = new adapted.ReadStream(path.join(fixture.roots.documents, "stream.txt"));
    expect(input).toBeInstanceOf(fs.ReadStream);
    const chunks = [];
    for await (const chunk of input) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe("streamed game file");
  });
  await expect(disk.stat(path.join(fixture.roots.documents, "stream.txt"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("both API aliases keep host path values and adapt game-owned filesystem and folder opening", () => {
  const api = load.call(parent, "vortex-api");
  expect(load.call(parent, "@nexusmods/vortex-api")).toBe(api);
  expect(api.fs).toBe(api.fs);
  expect(api.util.getVortexPath("documents")).toBe(fixture.roots.documents);
  owned(() => {
    api.fs.mkdirSync(fixture.roots.documents, { recursive: true });
    api.util.opn(fixture.roots.documents);
    api.util.opn("https://example.invalid/docs");
  });
  expect(fixture.open.mock.calls).toEqual([
    [path.join(user, "Documents")],
    ["https://example.invalid/docs"],
  ]);
});

test("unscoped, unregistered and sibling directories use the original filesystem", () => {
  const adapted = load.call(parent, "fs");
  expect(adapted.readFileSync(path.join(fixture.roots.documents, "saved.txt"), "utf8")).toBe(
    "host sentinel",
  );
  for (const filename of [
    path.join(fixture.base, "unregistered", "index.js"),
    path.join(fixture.base, "game-fixture-neighbor", "index.js"),
    path.join(fixture.base + "-neighbor", "game-fixture", "index.js"),
  ]) {
    expect(owned(() => load.call({ filename }, "fs"))).toBe(nativeRequire("fs"));
  }
});

test("Windows filesystem imports keep the original Node namespaces", () => {
  vi.stubGlobal("process", { ...originalProcess, platform: "win32" });
  for (const id of ["fs", "node:fs", "fs/promises", "node:fs/promises", "fs-extra"])
    expect(load.call(parent, id)).toBe(nativeRequire(id));
});

test("mutable module exports preserve patches and readonly exports reject changes", () => {
  const original = { writeFileSync: vi.fn(), marker: "original" };
  const adapted = gameUserPathNamespace("fs", original);
  const replacement = vi.fn();
  adapted.writeFileSync = replacement;
  expect(original.writeFileSync).toBe(replacement);
  Object.defineProperty(adapted, "marker", {
    value: "changed",
    configurable: false,
    writable: false,
  });
  expect(original.marker).toBe("changed");
  expect(adapted.marker).toBe("changed");
  expect(Object.getOwnPropertyDescriptor(adapted, "marker")?.configurable).toBe(false);
  expect(Reflect.set(adapted, "marker", "ignored")).toBe(false);
  const frozen = gameUserPathNamespace("fs", Object.freeze({ readFileSync: fs.readFileSync }));
  expect(Reflect.set(frozen, "readFileSync", replacement)).toBe(false);
});

test("single-game extension event I/O follows current discovery after registration", async () => {
  const adapted = load.call(parent, "fs");
  const api = load.call(parent, "vortex-api");
  fixture.games = [
    {
      id: "loader-fixture",
      extensionPath: path.dirname(path.dirname(parent.filename)),
      executable: () => "game.exe",
    },
  ];
  fixture.discoveries["loader-fixture"] = discovered;
  adapted.mkdirSync(fixture.roots.documents, { recursive: true });
  api.fs.writeFileSync(path.join(fixture.roots.documents, "saved.txt"), "event game file");
  expect(await disk.readFile(path.join(user, "Documents", "saved.txt"), "utf8")).toBe(
    "event game file",
  );
  const next = path.join(directory, "replaced-prefix");
  const nextUser = path.join(next, "pfx", "drive_c", "users", "steamuser");
  await disk.mkdir(path.join(nextUser, "Documents"), { recursive: true });
  await disk.writeFile(path.join(next, "pfx", "system.reg"), "WINE REGISTRY Version 2\n");
  fixture.prefix = next;
  fixture.discoveries["loader-fixture"] = {
    ...discovered,
    path: path.join(directory, "relocated-game"),
  };
  adapted.writeFileSync(path.join(fixture.roots.documents, "saved.txt"), "replacement prefix file");
  expect(await disk.readFile(path.join(nextUser, "Documents", "saved.txt"), "utf8")).toBe(
    "replacement prefix file",
  );
  expect(await disk.readFile(path.join(fixture.roots.documents, "saved.txt"), "utf8")).toBe(
    "host sentinel",
  );
});

test("a native single-game extension keeps host event files", async () => {
  fixture.games = [
    {
      id: "loader-fixture",
      extensionPath: path.dirname(path.dirname(parent.filename)),
      executable: () => "native.sh",
    },
  ];
  fixture.discoveries["loader-fixture"] = discovered;
  const adapted = load.call(parent, "node:fs");
  adapted.writeFileSync(path.join(fixture.roots.documents, "native.txt"), "native event file");
  expect(await disk.readFile(path.join(fixture.roots.documents, "native.txt"), "utf8")).toBe(
    "native event file",
  );
  await expect(disk.stat(path.join(user, "Documents", "native.txt"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("an explicitly locked module replacement obeys JavaScript descriptor invariants", () => {
  const original = { readFileSync: fs.readFileSync };
  const adapted = gameUserPathNamespace("fs", original);
  const replacement = vi.fn(() => "custom read");
  Object.defineProperty(adapted, "readFileSync", {
    value: replacement,
    configurable: false,
    writable: false,
  });
  expect(adapted.readFileSync).toBe(replacement);
  expect(original.readFileSync).toBe(replacement);
});

test("locking a module accessor retains its requested getter and filesystem behavior", () => {
  const original = { readFileSync: fs.readFileSync };
  const adapted = gameUserPathNamespace("fs", original);
  const getter = () => fs.readFileSync;
  Object.defineProperty(adapted, "readFileSync", { get: getter, configurable: false });
  expect(Object.getOwnPropertyDescriptor(adapted, "readFileSync")?.get).toBe(getter);
  owned(() => {
    load.call(parent, "fs").mkdirSync(fixture.roots.documents, { recursive: true });
    fs.writeFileSync(path.join(user, "Documents", "saved.txt"), "accessor prefix file");
    expect(adapted.readFileSync(path.join(fixture.roots.documents, "saved.txt"), "utf8")).toBe(
      "accessor prefix file",
    );
  });
  expect(fs.readFileSync(path.join(fixture.roots.documents, "saved.txt"), "utf8")).toBe(
    "host sentinel",
  );
});
