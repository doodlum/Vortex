import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "vitest";

const moduleUrl = new URL("./package-nosign.mjs", import.meta.url).href;
const { stageLinuxPackage, packageUnsigned } = await import(moduleUrl);
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (
      path.dirname(root) !== os.tmpdir() ||
      !path.basename(root).startsWith("vortex-package-test-")
    )
      throw new Error("Unexpected test cleanup path");
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vortex-package-test-"));
  roots.push(root);
  const deploy = path.join(root, "checkout/src/main/dist");
  const scratch = path.join(root, "scratch");
  await fs.mkdir(path.join(deploy, "build"), { recursive: true });
  await fs.mkdir(path.join(deploy, "node_modules/electron-builder"), { recursive: true });
  await fs.mkdir(scratch);
  await fs.writeFile(path.join(deploy, "package.json"), "{}");
  await fs.writeFile(path.join(deploy, "build/main.cjs"), "original payload");
  await fs.writeFile(
    path.join(deploy, "node_modules/electron-builder/package.json"),
    JSON.stringify({ bin: { "electron-builder": "cli.js" } }),
  );
  const config = {
    directories: { app: "./build", buildResources: "./nsis", output: "../../../dist" },
    linux: { icon: "../../../assets/images/vortex.png", target: ["zip"] },
    extraResources: [
      "./nsis/**/*",
      { from: "../../../locales", to: "locales" },
      { from: "node_modules/native/prebuilds", to: "native" },
    ],
    asarUnpack: ["**/*.node", "**/node_modules/libxml2-wasm/lib/**"],
  };
  await fs.writeFile(path.join(deploy, "electron-builder.config.json"), JSON.stringify(config));
  return { root, deploy: await fs.realpath(deploy), scratch, config };
}

test("isolates copied native payloads and preserves external resources/output and original inputs", async () => {
  const { deploy, scratch, config } = await fixture();
  const staged = await stageLinuxPackage(deploy, scratch);
  expect(await fs.readFile(path.join(staged.stage, "build/main.cjs"), "utf8")).toBe(
    "original payload",
  );
  const actual = JSON.parse(await fs.readFile(staged.configFile, "utf8"));
  expect(actual.directories).toEqual({
    ...config.directories,
    output: path.resolve(deploy, "../../../dist"),
  });
  expect(actual.linux.icon).toBe(path.resolve(deploy, config.linux.icon));
  expect(actual.extraResources).toEqual([
    "./nsis/**/*",
    { from: path.resolve(deploy, "../../../locales"), to: "locales" },
    { from: "node_modules/native/prebuilds", to: "native" },
  ]);
  expect(actual.asarUnpack).toEqual(config.asarUnpack);
  expect(
    JSON.parse(await fs.readFile(path.join(deploy, "electron-builder.config.json"), "utf8")),
  ).toEqual(config);
  await fs.writeFile(path.join(staged.stage, "build/main.cjs"), "changed copy");
  expect(await fs.readFile(path.join(deploy, "build/main.cjs"), "utf8")).toBe("original payload");
});

test("refuses scratch parents with a dependency tree that the collector could traverse", async () => {
  const { root, deploy, scratch } = await fixture();
  await fs.mkdir(path.join(root, "node_modules"));
  await expect(stageLinuxPackage(deploy, scratch)).rejects.toThrow("ancestor dependency tree");
  expect(await fs.readdir(scratch)).toEqual([]);
});

test.skipIf(process.platform === "win32")(
  "relocates absolute internal links and refuses links outside the deployment",
  async () => {
    const { root, deploy, scratch } = await fixture();
    await fs.symlink(path.join(deploy, "build/main.cjs"), path.join(deploy, "build/internal.cjs"));
    const staged = await stageLinuxPackage(deploy, scratch);
    expect(await fs.realpath(path.join(staged.stage, "build/internal.cjs"))).toBe(
      path.join(staged.stage, "build/main.cjs"),
    );
    await fs.symlink(root, path.join(deploy, "build/external"));
    await expect(stageLinuxPackage(deploy, scratch)).rejects.toThrow(
      "symlink leaves its dependency tree",
    );
    expect(await fs.readFile(path.join(deploy, "build/main.cjs"), "utf8")).toBe("original payload");
  },
);

test("retains failed packaging inputs and allows inspecting the exact failed config", async () => {
  const { deploy, scratch } = await fixture();
  let stagedDirectory = "";
  const code = await packageUnsigned({
    deploy,
    platform: "linux",
    temporaryRoot: scratch,
    run: async (_command: string, args: string[], options: { cwd: string }) => {
      stagedDirectory = options.cwd;
      expect(args.slice(-2)).toEqual(["--publish", "never"]);
      expect(JSON.parse(await fs.readFile(args[2], "utf8")).directories.output).toBe(
        path.resolve(deploy, "../../../dist"),
      );
      return 7;
    },
  });
  expect(code).toBe(7);
  expect(await fs.readFile(path.join(stagedDirectory, "build/main.cjs"), "utf8")).toBe(
    "original payload",
  );
  expect(await fs.readFile(path.join(deploy, "build/main.cjs"), "utf8")).toBe("original payload");
});

test("removes only the private copy after success and preserves the original deployment", async () => {
  const { deploy, scratch } = await fixture();
  expect(
    await packageUnsigned({ deploy, platform: "linux", temporaryRoot: scratch, run: () => 0 }),
  ).toBe(0);
  expect(await fs.readdir(scratch)).toEqual([]);
  expect(await fs.readFile(path.join(deploy, "build/main.cjs"), "utf8")).toBe("original payload");
});

test("Windows retains its existing unsigned packager command and deployment directory", async () => {
  const { deploy, scratch } = await fixture();
  const calls: unknown[] = [];
  expect(
    await packageUnsigned({
      deploy,
      platform: "win32",
      temporaryRoot: scratch,
      run: (...args: unknown[]) => {
        calls.push(args);
        return 0;
      },
    }),
  ).toBe(0);
  expect(calls).toEqual([
    [
      "pnpm",
      ["electron-builder", "--config", "./electron-builder.config.json", "--publish", "never"],
      { cwd: deploy, shell: true },
    ],
  ]);
  expect(await fs.readdir(scratch)).toEqual([]);
});

test.skipIf(process.platform === "win32")(
  "rejects an indirect link that escapes through an internal alias and parent traversal",
  async () => {
    const { deploy, scratch } = await fixture();
    const outside = path.join(path.dirname(deploy), "outside");
    await fs.writeFile(outside, "outside sentinel");
    await fs.symlink(deploy, path.join(deploy, "build/alias"));
    await fs.symlink("alias/../outside", path.join(deploy, "build/link"));
    expect(await fs.readFile(path.join(deploy, "build/link"), "utf8")).toBe("outside sentinel");
    await expect(stageLinuxPackage(deploy, scratch)).rejects.toThrow(
      "symlink leaves its dependency tree",
    );
    expect(await fs.readFile(outside, "utf8")).toBe("outside sentinel");
  },
);
