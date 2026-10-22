import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "vitest";

const {
  parseOptions,
  packageLinux,
  flatpakManifest,
  desktopEntry,
  FLATPAK_LAUNCHER,
  SNAP_LAUNCHER,
} = await import(new URL("../../scripts/package-linux.mjs", import.meta.url).href);
const { copyTree, readTree, treeDigest, toolIdentity } = await import(
  new URL("../../scripts/linux-package-files.mjs", import.meta.url).href
);
const { downloadGem, parseFpmLock, prepareFpm } = await import(
  new URL("../../scripts/linux-fpm.mjs", import.meta.url).href
);
const { runCommand } = await import(
  new URL("../../scripts/linux-package-command.mjs", import.meta.url).href
);
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (
      path.dirname(root) !== os.tmpdir() ||
      !path.basename(root).startsWith("vortex-linux-package-test-")
    )
      throw new Error("Unexpected Linux package test cleanup target");
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vortex-linux-package-test-"));
  roots.push(root);
  const input = path.join(root, "input");
  await fs.mkdir(input);
  await fs.writeFile(path.join(input, "binary"), Buffer.from([0, 255, 128, 10]));
  return { root, input };
}

test("snapshot copies bytes independently and leaves the original unchanged", async () => {
  const { root, input } = await fixture();
  const before = await readTree(input);
  const destination = path.join(root, "snapshot");
  const copy = await copyTree(input, destination);
  expect(treeDigest(copy.snapshot)).toBe(treeDigest(before));
  await fs.writeFile(path.join(destination, "binary"), "later build mutation");
  expect(await fs.readFile(path.join(input, "binary"))).toEqual(Buffer.from([0, 255, 128, 10]));
});

test("rejects output or tool caches inside input before creating them or running tools", async () => {
  const { root, input } = await fixture();
  const before = await readTree(input);
  for (const option of ["output", "cache"]) {
    const options = {
      ...parseOptions([], root),
      input,
      output: path.join(root, "output"),
      cache: path.join(root, "cache"),
      [option]: path.join(input, "new-directory"),
    };
    await expect(packageLinux(options, { platform: "linux", arch: "x64" })).rejects.toThrow(
      "separate",
    );
    await expect(fs.stat(path.join(input, "new-directory"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  }
  expect(treeDigest(await readTree(input))).toBe(treeDigest(before));
});

test.runIf(process.platform !== "win32")(
  "rejects prefix-neighbour escapes and output through a directory alias",
  async () => {
    const { root, input } = await fixture();
    const other = path.join(root, "input-neighbour");
    await fs.mkdir(other);
    await fs.writeFile(path.join(other, "private"), "outside");
    await fs.symlink(path.join(other, "private"), path.join(input, "escape"));
    await expect(copyTree(input, path.join(root, "snapshot"))).rejects.toThrow("leaves its tree");
    await fs.unlink(path.join(input, "escape"));
    const alias = path.join(root, "alias");
    await fs.symlink(input, alias, "dir");
    await expect(
      packageLinux(
        { ...parseOptions([], root), input, output: path.join(alias, "nested") },
        { platform: "linux", arch: "x64" },
      ),
    ).rejects.toThrow("separate");
    expect(await fs.readFile(path.join(other, "private"), "utf8")).toBe("outside");
  },
);

test.runIf(process.platform !== "win32")(
  "relocates absolute internal links instead of retaining a dependency on the original tree",
  async () => {
    const { root, input } = await fixture();
    await fs.symlink(path.join(input, "binary"), path.join(input, "alias"));
    const snapshot = path.join(root, "snapshot");
    await copyTree(input, snapshot);
    expect(path.isAbsolute(await fs.readlink(path.join(snapshot, "alias")))).toBe(false);
    await fs.rename(input, path.join(root, "retired-input"));
    expect(await fs.readFile(path.join(snapshot, "alias"))).toEqual(Buffer.from([0, 255, 128, 10]));
  },
);

test("rejects unsupported targets and path-shaped package identifiers before execution", () => {
  expect(() => parseOptions(["--formats", "rpm,invalid"])).toThrow("formats");
  expect(() => parseOptions(["--formats", "snap,snap"])).toThrow("distinct");
  expect(() => parseOptions(["--snap-name", "../../other"])).toThrow("Snap");
  expect(() => parseOptions(["--flatpak-branch", "../other"])).toThrow("branch");
});

test("corrupt download bytes are removed and cannot reach a gem installer", async () => {
  const { root } = await fixture();
  const expected = Buffer.from("verified gem bytes");
  const pin = {
    name: "fixture",
    version: "1.0.0",
    sha256: createHash("sha256").update(expected).digest("hex"),
  };
  const destination = path.join(root, "fixture.gem");
  await expect(
    downloadGem(
      pin,
      "https://rubygems.org/downloads/",
      destination,
      async () => new Response("wrong bytes"),
    ),
  ).rejects.toThrow("Checksum mismatch");
  await expect(fs.stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  await downloadGem(
    pin,
    "https://rubygems.org/downloads/",
    destination,
    async () => new Response(expected),
  );
  expect(await fs.readFile(destination)).toEqual(expected);
});

test("the tool lock cannot redirect downloads or contain duplicate package pins", async () => {
  const lock = JSON.parse(
    await fs.readFile(new URL("../../scripts/linux-fpm-lock.json", import.meta.url), "utf8"),
  );
  expect(() =>
    parseFpmLock(JSON.stringify({ ...lock, registry: "https://example.invalid/" })),
  ).toThrow("lock");
  expect(() =>
    parseFpmLock(JSON.stringify({ ...lock, gems: [...lock.gems, lock.gems[0]] })),
  ).toThrow("pin");
});

test.runIf(process.platform === "linux")(
  "both shell launchers forward raw URLs and unrelated options without interpreting their contents",
  async () => {
    const { root } = await fixture();
    const bin = path.join(root, "bin");
    const snap = path.join(root, "snap root");
    await fs.mkdir(bin);
    await fs.mkdir(path.join(snap, "app"), { recursive: true });
    const recorder = path.join(root, "record.cjs");
    await fs.writeFile(recorder, "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
    const executable = '#!/bin/sh\nexec "$NODE_BINARY" "$ARGV_RECORDER" "$@"\n';
    await fs.writeFile(path.join(bin, "zypak-wrapper"), executable, { mode: 0o755 });
    await fs.writeFile(path.join(snap, "app/vortex"), executable, { mode: 0o755 });
    const values = [
      [],
      ["nxm://stardewvalley/mods/1/files/2"],
      ["--user-data", "a space é % $()", "--start-minimized"],
      ["--download", "nxm://example/mods/1/files/2"],
    ];
    for (const [name, content, prefix] of [
      ["flatpak", FLATPAK_LAUNCHER, ["/app/main/vortex"]],
      ["snap", SNAP_LAUNCHER, []],
    ] as const) {
      const wrapper = path.join(root, name);
      await fs.writeFile(wrapper, content);
      for (const args of values) {
        const output = execFileSync("/bin/sh", [wrapper, ...args], {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            SNAP: snap,
            NODE_BINARY: process.execPath,
            ARGV_RECORDER: recorder,
          },
        });
        expect(JSON.parse(output)).toEqual([...prefix, ...args]);
      }
    }
  },
);

test.runIf(process.platform === "linux")(
  "failed tools do not leave a TERM-resistant compressor running",
  async () => {
    const { root } = await fixture();
    const pidFile = path.join(root, "pid");
    const child = path.join(root, "child.cjs");
    const parent = path.join(root, "parent.cjs");
    await fs.writeFile(
      child,
      "process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(process.argv[2],String(process.pid));setInterval(()=>{},1000)",
    );
    await fs.writeFile(
      parent,
      "const c=require('node:child_process').spawn(process.execPath,[process.argv[2],process.argv[3]],{stdio:'ignore'});setTimeout(()=>process.exit(3),600)",
    );
    await expect(
      runCommand(process.execPath, [parent, child, pidFile], {
        cwd: root,
        env: process.env,
        log: path.join(root, "command.log"),
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow("exited 3");
    const pid = Number(await fs.readFile(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  },
  20_000,
);

test.each([false, true])(
  "uses the configured prepared app rather than its workspace package (mismatch: %s)",
  async (mismatch) => {
    const { root, input } = await fixture();
    const source = path.resolve(import.meta.dirname, "../..");
    const config = JSON.parse(
      await fs.readFile(path.join(source, "src/main/electron-builder.config.json"), "utf8"),
    );
    const workspace = await fs.readFile(path.join(source, "src/main/package.json"), "utf8");
    expect(JSON.parse(workspace).name).toBe("@vortex/main");
    const deploy = path.join(root, "deployment");
    const app = path.resolve(deploy, config.directories.app);
    await fs.mkdir(app, { recursive: true });
    await fs.writeFile(path.join(deploy, "package.json"), workspace);
    const metadata = {
      name: "Vortex",
      version: "1.0.0",
      license: "GPL-3.0-only",
      homepage: "https://www.nexusmods.com/about/vortex/",
    };
    await fs.writeFile(path.join(app, "package.json"), JSON.stringify(metadata));
    const packed = path.join(root, "packed");
    await fs.mkdir(packed);
    await fs.writeFile(
      path.join(packed, "package.json"),
      JSON.stringify({ ...metadata, version: mismatch ? "9.0.0" : metadata.version }),
    );
    const mainRequire = createRequire(path.join(source, "src/main/package.json"));
    const builderRequire = createRequire(mainRequire.resolve("electron-builder/package.json"));
    const libraryRequire = createRequire(builderRequire.resolve("app-builder-lib/package.json"));
    const asar = libraryRequire("@electron/asar");
    await fs.mkdir(path.join(input, "resources"));
    await asar.createPackage(packed, path.join(input, "resources/app.asar"));
    const calls: string[] = [];
    let failure: unknown;
    try {
      await packageLinux(
        {
          ...parseOptions(["--formats", "tar.gz"], source),
          input,
          deploy,
          output: path.join(root, "output"),
          cache: path.join(root, "cache"),
        },
        {
          platform: "linux",
          arch: "x64",
          run: async (_command: string, args: string[]) => {
            calls.push(args[0]);
            throw new Error("reached packaged dependency verification");
          },
        },
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).cause).toBeInstanceOf(Error);
    expect(((failure as Error).cause as Error).message).toBe(
      mismatch
        ? "Prepared deployment and common app.asar disagree"
        : "reached packaged dependency verification",
    );
    expect(calls).toEqual(mismatch ? [] : [path.join(source, "scripts/verify-packaged-asar.mjs")]);
  },
  // Includes cold loading and schema validation of the real packaging consumers.
  20_000,
);

test.runIf(process.platform === "linux")(
  "rejects an FPM cache after Ruby is replaced in place even with the same reported version",
  async () => {
    const { root } = await fixture();
    const bin = path.join(root, "tools");
    await fs.mkdir(bin);
    const ruby = path.join(bin, "ruby");
    const gem = path.join(bin, "gem");
    const command =
      '#!/bin/sh\n[ "$#" = 1 ] && [ "$1" = --version ] || exit 23\nprintf "fixture version 1\\n"\n';
    await fs.writeFile(ruby, command, { mode: 0o755 });
    await fs.writeFile(gem, command, { mode: 0o755 });
    const env = { ...process.env, PATH: bin };
    const identity = await toolIdentity("ruby", ["--version"], env);
    const lock = await fs.readFile(new URL("../../scripts/linux-fpm-lock.json", import.meta.url));
    const lockSha256 = createHash("sha256").update(lock).digest("hex");
    const cache = path.join(root, "cache");
    const directory = path.join(cache, `fpm-${lockSha256}`);
    await fs.mkdir(path.join(directory, "gems"), { recursive: true });
    await fs.mkdir(path.join(directory, "bin"));
    await fs.writeFile(
      path.join(directory, "receipt.json"),
      JSON.stringify({
        lockSha256,
        ruby: identity,
        rubyGems: await toolIdentity("gem", ["--version"], env),
        installedTreeSha256: treeDigest({}),
        binTreeSha256: treeDigest({}),
      }),
    );
    await fs.appendFile(ruby, "# interpreter replaced, version unchanged\n");
    expect((await toolIdentity("ruby", ["--version"], env)).version).toBe(identity.version);
    let installers = 0;
    await expect(
      prepareFpm({
        cacheDirectory: cache,
        env,
        run: async () => {
          installers++;
        },
      }),
    ).rejects.toThrow("cache is inconsistent");
    expect(installers).toBe(0);
    expect(await fs.readdir(cache)).toEqual([path.basename(directory)]);
  },
);

test("Flatpak application IDs default to Vortex and permit isolated development installs", () => {
  expect(parseOptions([]).flatpakId).toBe("com.nexusmods.vortex");
  expect(parseOptions(["--flatpak-app-id", "org.example.VortexTrial"]).flatpakId).toBe(
    "org.example.VortexTrial",
  );
});

test.each(["com.nexusmods.vortex", "org.example.VortexTrial"])(
  "Flatpak admits the bundled static i386 QuickBMS helper for %s",
  (appId) => {
    expect(flatpakManifest({ branch: "testing", appId })["finish-args"]).toContain(
      "--allow=multiarch",
    );
  },
);

test.each([
  "../../other",
  "org.example",
  "org..Other",
  "1org.example.App",
  "org.1example.App",
  "org.example.1App",
  "org.example.App/other",
  "org.example.App\nInjected=value",
  "org.example.App;command",
  "org." + "x".repeat(250) + ".App",
])("rejects unsafe or malformed Flatpak application IDs: %s", (id) => {
  expect(() => parseOptions(["--flatpak-app-id", id])).toThrow("Flatpak application ID");
  expect(() => flatpakManifest({ branch: "testing", appId: id })).toThrow("Flatpak application ID");
});

test.each(["com.nexusmods.vortex", "org.example.VortexTrial"])(
  "Flatpak manifest and exported desktop metadata share selected identity %s",
  (appId) => {
    const payload = "/build/common-payload",
      wrapper = "/build/vortex",
      desktop = "/build/selected.desktop",
      icon = "/build/icon.png",
      metainfo = "/build/selected.metainfo.xml";
    const manifest = flatpakManifest({
      branch: "testing",
      appId,
      payload,
      wrapper,
      desktop,
      icon,
      metainfo,
    });
    expect(manifest["app-id"]).toBe(appId);
    expect(manifest.command).toBe("vortex");
    expect(manifest.modules[0].sources[0]).toEqual({ type: "dir", path: payload, dest: "payload" });
    expect(manifest.modules[0].sources).toContainEqual({
      type: "file",
      path: desktop,
      "dest-filename": appId + ".desktop",
    });
    expect(manifest.modules[0].sources).toContainEqual({
      type: "file",
      path: metainfo,
      "dest-filename": appId + ".metainfo.xml",
    });
    expect(manifest.modules[0]["build-commands"]).toContain(
      "install -Dm644 " + appId + ".desktop /app/share/applications/" + appId + ".desktop",
    );
    expect(manifest.modules[0]["build-commands"]).toContain(
      "install -Dm644 icon.png /app/share/icons/hicolor/256x256/apps/" + appId + ".png",
    );
    expect(desktopEntry("vortex %u", appId, appId)).toContain("StartupWMClass=" + appId + "\n");
    if (appId !== "com.nexusmods.vortex")
      expect(JSON.stringify(manifest)).not.toContain("com.nexusmods.vortex");
  },
);

test.each(["_org.example.App", "org.example." + "A".repeat(178 - "org.example.".length)])(
  "rejects IDs incompatible with current desktop consumers before packaging: %s",
  (appId) => {
    expect(() => parseOptions(["--flatpak-app-id", appId])).toThrow("Flatpak application ID");
    expect(() => flatpakManifest({ branch: "testing", appId })).toThrow("Flatpak application ID");
  },
);

test.each([
  "org._example._QA",
  "org.example.QA-test",
  "org.example." + "A".repeat(177 - "org.example.".length),
])("accepts supported non-default ID boundaries: %s", (appId) => {
  expect(parseOptions(["--flatpak-app-id", appId]).flatpakId).toBe(appId);
  expect(flatpakManifest({ branch: "testing", appId })["app-id"]).toBe(appId);
});

test.runIf(process.platform === "linux")(
  "the maximum supported ID leaves room for real atomic protocol writes",
  async () => {
    const { root } = await fixture();
    const { writeIntegrationFile } = await import("./src/linuxIntegrationFiles");
    const appId = "org.example." + "A".repeat(177 - "org.example.".length);
    const filename = appId + ".handler." + "a".repeat(20) + ".desktop";
    const destination = path.join(root, filename);
    writeIntegrationFile(destination, "inert protocol boundary fixture");
    expect(await fs.readFile(destination, "utf8")).toBe("inert protocol boundary fixture");
    expect((await fs.readdir(root)).sort()).toEqual(["input", filename].sort());
  },
);
