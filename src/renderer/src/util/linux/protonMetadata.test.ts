import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { stringify, type KVBlock } from "@nexusmods/steam-kv-parser";
import { afterEach, expect, it, vi } from "vitest";

import {
  readCustomProtonName,
  resolveDependencyTarget,
  resolveExactRuntimeName,
} from "./protonMetadata";

// Every test builds and resolves a real Steam tree in a temporary directory. Each takes well
// under a second alone, but a full verify run shares the disk with every other suite, which
// stretched one past the default 5 seconds on Windows.
vi.setConfig({ testTimeout: 30_000 });

const temporaryRoots: string[] = [];

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    if (!path.resolve(root).startsWith(path.join(os.tmpdir(), "vortex-dependency-target-")))
      throw new Error("Unexpected fixture cleanup path");
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function removeFixtureTree(root: string, target: string) {
  const absoluteRoot = path.resolve(root);
  const absoluteTarget = path.resolve(target);
  const relative = path.relative(absoluteRoot, absoluteTarget);
  if (
    relative === "" ||
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`)
  )
    throw new Error("Fixture deletion escaped its temporary root");
  await fs.rm(absoluteTarget, { recursive: true, force: true });
}

async function write(file: string, contents: string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents);
}

function object(key: string, values: Record<string, string>): KVBlock {
  return {
    type: "block",
    key,
    children: Object.entries(values).map(([key, value]) => ({ type: "leaf", key, value })),
  };
}

async function app(library: string, appId: string, installDir: string, name: string) {
  const install = path.join(library, "steamapps", "common", installDir);
  await fs.mkdir(install, { recursive: true });
  await write(
    path.join(library, "steamapps", `appmanifest_${appId}.acf`),
    stringify(
      object("AppState", {
        appid: appId,
        name,
        installdir: installDir,
        StateFlags: "4",
        LastUpdated: "10",
      }),
    ),
  );
  return install;
}

async function libraries(steam: string, roots: string[], where = "steamapps") {
  await write(
    path.join(steam, where, "libraryfolders.vdf"),
    stringify({
      type: "block",
      key: "libraryfolders",
      children: roots.map((root, index) => object(String(index), { path: root })),
    }),
  );
}

async function custom(root: string, name: string, installPath = ".", secondName?: string) {
  const first = object(name, {
    install_path: installPath,
    from_oslist: "windows",
    to_oslist: "linux",
  });
  await write(
    path.join(root, "compatibilitytool.vdf"),
    stringify({
      type: "block",
      key: "CompatibilityTools",
      children: [
        {
          type: "block",
          key: "Compat_Tools",
          children: [
            first,
            ...(secondName === undefined
              ? []
              : [
                  object(secondName, {
                    install_path: ".",
                    from_oslist: "windows",
                    to_oslist: "linux",
                  }),
                ]),
          ],
        },
      ],
    }),
  );
  await write(path.join(root, "proton"), "inert launcher");
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vortex-dependency-target-"));
  temporaryRoots.push(root);
  const steam = path.join(root, "snap-like-client");
  await fs.mkdir(path.join(steam, "ubuntu12_32"), { recursive: true });
  const game = await app(steam, "42", "Game", "Fixture Game");
  const proton = await app(steam, "1493710", "Renamed folder", "Proton 11.0");
  await write(path.join(proton, "proton"), "inert launcher");
  const compat = path.join(steam, "steamapps", "compatdata", "42");
  await fs.mkdir(path.join(compat, "pfx"), { recursive: true });
  await write(path.join(compat, "pfx.lock"), "");
  await libraries(steam, [steam]);
  const input = {
    appId: "42",
    steamPath: steam,
    gamePath: game,
    compatDataPath: compat,
    protonPath: proton,
  };
  return { root, steam, game, proton, compat, input };
}

async function runtimeFixture() {
  const f = await fixture();
  const runtime = await app(f.steam, "1628350", "Runtime", "Steam Linux Runtime 3.0 (sniper)");
  await write(
    path.join(f.proton, "toolmanifest.vdf"),
    stringify(object("manifest", { require_tool_appid: "1628350" })),
  );
  await write(
    path.join(runtime, "toolmanifest.vdf"),
    stringify(object("manifest", { version: "2" })),
  );
  await write(path.join(runtime, "run"), "inert launcher");
  const variable = path.join(runtime, "var");
  await fs.mkdir(variable);
  const lock = path.join(runtime, "platform", "files", ".ref");
  await write(lock, "");
  return { ...f, runtime, variable, lock };
}

it("refuses duplicate installations of the exact required runtime AppID", async () => {
  const f = await runtimeFixture();
  const other = path.join(f.root, "other-library");
  await app(other, "1628350", "Another runtime", "Steam Linux Runtime 3.0 (sniper)");
  await libraries(f.steam, [f.steam, other]);
  await expect(resolveDependencyTarget(f.input, { customToolRoots: [] })).rejects.toThrow(
    "one initialized Steam Runtime",
  );
});

it.runIf(process.platform === "linux").each(["var", "lock", "installation"])(
  "refuses a runtime %s redirected outside its installation",
  async (kind) => {
    const f = await runtimeFixture();
    const outside = path.join(f.root, "outside");
    await fs.mkdir(outside);
    if (kind === "installation") {
      const destination = path.join(outside, "Runtime");
      await fs.rename(f.runtime, destination);
      await fs.symlink(destination, f.runtime, "dir");
    } else if (kind === "var") {
      await fs.rmdir(f.variable);
      await fs.symlink(outside, f.variable, "dir");
    } else {
      const sentinel = path.join(outside, "sentinel");
      await write(sentinel, "preserved");
      await fs.rm(f.lock);
      await fs.symlink(sentinel, f.lock, "file");
    }
    await expect(resolveDependencyTarget(f.input, { customToolRoots: [] })).rejects.toThrow(
      /redirected outside/,
    );
  },
);

it("uses official appmanifest name instead of folder basename, and emits canonical exact target roots", async () => {
  const f = await fixture();
  const result = await resolveDependencyTarget(f.input, { customToolRoots: [] });
  expect(result).toEqual({
    steamPath: await fs.realpath(f.steam),
    gamePath: await fs.realpath(f.game),
    protonPath: await fs.realpath(f.proton),
    compatDataPath: await fs.realpath(f.compat),
    protonName: "Proton 11.0",
    readOnlyRoots: [await fs.realpath(f.steam), await fs.realpath(f.proton)].sort(),
    runtimeWritePaths: [],
  });
});

it("refuses another initialized prefix or a duplicate game AppID in another library", async () => {
  const f = await fixture();
  const otherPrefix = path.join(f.root, "unrelated-prefix");
  await fs.mkdir(path.join(otherPrefix, "pfx"), { recursive: true });
  await write(path.join(otherPrefix, "pfx.lock"), "");
  await expect(
    resolveDependencyTarget({ ...f.input, compatDataPath: otherPrefix }, { customToolRoots: [] }),
  ).rejects.toThrow("selected installation");
  const other = path.join(f.root, "other-library");
  await app(other, "42", "Game", "Other Game");
  await libraries(f.steam, [f.steam, other]);
  await expect(resolveDependencyTarget(f.input, { customToolRoots: [] })).rejects.toThrow(
    "selected installation",
  );
});

it("grants only the selected runtime's cache and existing deployment locks writable access", async () => {
  const f = await fixture();
  const runtime = await app(f.steam, "1628350", "Runtime", "Steam Linux Runtime 3.0 (sniper)");
  await write(
    path.join(f.proton, "toolmanifest.vdf"),
    stringify(object("manifest", { require_tool_appid: "1628350" })),
  );
  await write(
    path.join(runtime, "toolmanifest.vdf"),
    stringify(object("manifest", { version: "2" })),
  );
  await write(path.join(runtime, "run"), "inert launcher");
  await fs.mkdir(path.join(runtime, "var"));
  const lock = path.join(runtime, "platform", "files", ".ref");
  await write(lock, "");
  await write(path.join(runtime, "platform", "files", "immutable-payload"), "preserved");
  const result = await resolveDependencyTarget(f.input, { customToolRoots: [] });
  expect(result.runtimePath).toBe(await fs.realpath(runtime));
  expect(result.runtimeWritePaths).toEqual(
    [await fs.realpath(lock), await fs.realpath(path.join(runtime, "var"))].sort(),
  );
  await fs.rm(path.join(runtime, "run"));
  await expect(resolveDependencyTarget(f.input, { customToolRoots: [] })).rejects.toThrow(
    "Steam Runtime launcher",
  );
});

it("includes external library and third-library runtime metadata roots read-only", async () => {
  const f = await fixture();
  const other = path.join(f.root, "external library");
  const runtime = path.join(f.root, "runtime library");
  const proton = await app(other, "2805730", "Actual Proton", "Proton Experimental");
  await write(path.join(proton, "proton"), "");
  await app(runtime, "1628350", "SteamLinuxRuntime_sniper", "Steam Linux Runtime 3.0 (sniper)");
  await libraries(f.steam, [f.steam, other, runtime]);
  const result = await resolveDependencyTarget(
    { ...f.input, protonPath: proton },
    { customToolRoots: [] },
  );
  expect(result.protonName).toBe("Proton Experimental");
  expect(result.readOnlyRoots).toContain(await fs.realpath(runtime));
  expect(result.readOnlyRoots).toContain(await fs.realpath(other));
});

it("reads first custom internal key with original case, even when folder/display names differ", async () => {
  const f = await fixture();
  const tool = path.join(f.steam, "compatibilitytools.d", "TotallyDifferentFolder");
  await custom(tool, "Exact-GE-Key", ".", "ignored-second-key");
  expect(await readCustomProtonName(tool)).toEqual({
    name: "Exact-GE-Key",
    path: await fs.realpath(tool),
  });
  expect(await resolveExactRuntimeName(f.steam, tool, { customToolRoots: [] })).toBe(
    "Exact-GE-Key",
  );
});

it("rejects two exact names mapped to different real installations", async () => {
  const f = await fixture();
  const alternate = path.join(f.root, "other");
  const duplicate = await app(alternate, "9999", "Second Proton", "Proton 11.0");
  await write(path.join(duplicate, "proton"), "");
  await libraries(f.steam, [f.steam, alternate]);
  await expect(resolveDependencyTarget(f.input, { customToolRoots: [] })).rejects.toThrow(
    "multiple installations",
  );
});

it("rejects same Proton AppID at another path even if metadata name differs", async () => {
  const f = await fixture();
  const alternate = path.join(f.root, "other");
  const duplicate = await app(alternate, "1493710", "Second Proton", "Different metadata name");
  await write(path.join(duplicate, "proton"), "");
  await libraries(f.steam, [f.steam, alternate]);
  await expect(resolveDependencyTarget(f.input, { customToolRoots: [] })).rejects.toThrow(
    "AppID has multiple installations",
  );
});

it("rejects collision with custom metadata instead of guessing official precedence", async () => {
  const f = await fixture();
  await custom(path.join(f.steam, "compatibilitytools.d", "custom"), "Proton 11.0");
  await expect(resolveDependencyTarget(f.input, { customToolRoots: [] })).rejects.toThrow(
    "multiple installations",
  );
});

it("does not guess a name for a launcher without recognized metadata", async () => {
  const f = await fixture();
  await fs.unlink(path.join(f.steam, "steamapps", "appmanifest_1493710.acf"));
  await expect(resolveDependencyTarget(f.input, { customToolRoots: [] })).rejects.toThrow(
    "missing or ambiguous helper metadata",
  );
});

it("does not claim a config-only library is reachable by Protontricks", async () => {
  const f = await fixture();
  const alternate = path.join(f.root, "config-only");
  const selected = await app(alternate, "9999", "Proton", "Proton 19.0");
  await write(path.join(selected, "proton"), "");
  await libraries(f.steam, [f.steam, alternate], "config");
  await expect(resolveExactRuntimeName(f.steam, selected, { customToolRoots: [] })).rejects.toThrow(
    "missing or ambiguous",
  );
});

it("rejects invalid identity and an uninitialized prefix", async () => {
  const f = await fixture();
  await expect(resolveDependencyTarget({ ...f.input, appId: "../42" })).rejects.toThrow(
    "invalid Steam AppID",
  );
  await expect(resolveDependencyTarget({ ...f.input, gamePath: "relative" })).rejects.toThrow(
    "absolute path",
  );
  await removeFixtureTree(f.root, path.join(f.compat, "pfx"));
  await expect(resolveDependencyTarget(f.input)).rejects.toThrow();
});

it("preserves a lexical alias only when it identifies the same real runtime", async (context) => {
  if (process.platform === "win32") {
    context.skip();
    return;
  }
  const f = await fixture();
  const alias = path.join(f.root, "runtime-alias");
  await fs.symlink(f.proton, alias, "dir");
  const result = await resolveDependencyTarget(
    { ...f.input, protonPath: alias },
    { customToolRoots: [] },
  );
  expect(result.protonName).toBe("Proton 11.0");
  expect(result.readOnlyRoots).toContain(await fs.realpath(f.proton));
});

it("rejects a prefix symlink which would make the writable target point elsewhere", async (context) => {
  if (process.platform === "win32") {
    context.skip();
    return;
  }
  const f = await fixture();
  await removeFixtureTree(f.root, path.join(f.compat, "pfx"));
  await fs.symlink(f.game, path.join(f.compat, "pfx"), "dir");
  await expect(resolveDependencyTarget(f.input, { customToolRoots: [] })).rejects.toThrow(
    "redirected by a symlink",
  );
});

it("fails closed on malformed metadata instead of falling back to a folder name", async () => {
  const f = await fixture();
  await write(path.join(f.steam, "steamapps", "appmanifest_1493710.acf"), '"AppState" {');
  await expect(resolveDependencyTarget(f.input, { customToolRoots: [] })).rejects.toThrow();
});
