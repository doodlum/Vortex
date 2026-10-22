import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import Module, { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { Script } from "node:vm";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { executableName } from "./commandLine";

const require = createRequire(import.meta.url);
const extension = path.resolve(import.meta.dirname, "..");
const digest = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
let root: string;
const children = new Set<ChildProcess>();
beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "quickbms-public-test-"));
  vi.stubEnv("VORTEX_QBMS_LITERAL_PATH_TEST", "expanded-value");
});
afterEach(async () => {
  try {
    await Promise.all(
      [...children].map(
        (child) =>
          new Promise<void>((resolve, reject) => {
            if (child.exitCode !== null || child.signalCode !== null) {
              resolve();
              return;
            }
            const force = setTimeout(() => child.kill("SIGKILL"), 2000);
            const deadline = setTimeout(
              () => reject(new Error("Owned QuickBMS child did not stop")),
              5000,
            );
            child.once("close", () => {
              clearTimeout(force);
              clearTimeout(deadline);
              resolve();
            });
            child.kill();
          }),
      ),
    );
  } finally {
    vi.unstubAllEnvs();
    await fsp.rm(root, { recursive: true, force: true });
  }
});

/** Load the actual built extension, substituting only its external Vortex API boundary. */
function publicApis(userData: string) {
  const entry = path.join(extension, "dist/index.cjs");
  const realRequire = createRequire(entry);
  const calls: { command: string; args: string[]; options: any }[] = [];
  const api = {
    fs: {
      ensureDirAsync: (directory: string) => fsp.mkdir(directory, { recursive: true }),
      writeFileAsync: (...args: Parameters<typeof fsp.writeFile>) => fsp.writeFile(...args),
      statAsync: (file: string) => fsp.stat(file),
      removeAsync: (file: string) => fsp.rm(file, { force: true, recursive: true }),
      readFileAsync: (...args: Parameters<typeof fsp.readFile>) => fsp.readFile(...args),
      createWriteStream: fs.createWriteStream,
    },
    log: vi.fn<(...args: unknown[]) => void>(),
    util: {
      getVortexPath: () => userData,
      ArgumentInvalid: class extends Error {},
      ProcessCanceled: class extends Error {},
      getSafe: (state: any, keys: string[], fallback: any) =>
        keys.reduce((value, key) => value?.[key], state) ?? fallback,
    },
    selectors: { gameById: () => ({ id: "fixture" }), activeGameId: () => "fixture" },
  };
  const externalRequire = (name: string) => {
    if (name === "@nexusmods/vortex-api") return api;
    const actual = realRequire(name);
    if (name === "child_process" || name === "node:child_process") {
      return {
        ...actual,
        spawn: (command: string, args: string[], options: any) => {
          calls.push({ command, args, options });
          const childProcesses: typeof import("node:child_process") = actual;
          const child = childProcesses.spawn(command, args, options);
          children.add(child);
          child.once("close", () => children.delete(child));
          return child;
        },
      };
    }
    return actual;
  };
  const mod: { exports: unknown } = { exports: {} };
  const execute = new Script(Module.wrap(fs.readFileSync(entry, "utf8")), {
    filename: entry,
  }).runInThisContext();
  execute(mod.exports, externalRequire, mod, entry, path.dirname(entry));
  const registry = new Map<string, (...args: any[]) => any>();
  const events = new EventEmitter();
  if (typeof mod.exports !== "function")
    throw new TypeError("Built QuickBMS entry must export its initializer function");
  mod.exports({
    registerAPI: (name: string, fn: (...args: any[]) => any) => registry.set(name, fn),
    once: (fn: () => void) => fn(),
    api: {
      events,
      store: { getState: () => ({ session: { notifications: { notifications: [] } } }) },
      dismissNotification: vi.fn<(...args: unknown[]) => void>(),
      sendNotification: vi.fn<(...args: unknown[]) => void>(),
      showErrorNotification: vi.fn<(...args: unknown[]) => void>(),
      showDialog: vi.fn<(...args: unknown[]) => void>(),
    },
  });
  registry.get("qbmsRegisterGame")("fixture");
  events.emit("gamemode-activated", "fixture");
  return { registry, calls };
}

it("runs the built public APIs with literal paths and identical archive transformations", async () => {
  const executable = path.join(extension, "dist", executableName());
  const pins = require("../artifacts.json");
  expect(digest(await fsp.readFile(executable))).toBe(pins[process.platform].executableSha256);
  const userData = path.join(root, "user-data");
  await fsp.mkdir(userData);
  const { registry, calls } = publicApis(userData);
  const literal = "%VORTEX_QBMS_LITERAL_PATH_TEST% $VORTEX_QBMS_LITERAL_PATH_TEST & literal";
  const script = path.join(root, `script ${literal}.bms`);
  const archive = path.join(root, `archive ${literal}.bin`);
  const output = path.join(root, `output ${literal}`);
  await fsp.mkdir(output);
  await fsp.writeFile(
    script,
    'get OFFSET long\nget SIZE long\nlog "Payload/Value with space.txt" OFFSET SIZE\n',
  );
  const original = Buffer.alloc(12);
  original.writeUInt32LE(8, 0);
  original.writeUInt32LE(4, 4);
  original.write("base", 8);
  await fsp.writeFile(archive, original);
  const payload = path.join(output, "Payload", "Value with space.txt");
  const states: string[] = [];
  const invoke = async (name: string, options?: Record<string, unknown>, bms = script) => {
    const callbacks: { error: unknown; data: unknown }[] = [];
    await registry.get(name)({
      gameMode: "fixture",
      bmsScriptPath: bms,
      archivePath: archive,
      operationPath: output,
      quiet: true,
      qbmsOptions: options,
      callback: (error: unknown, data: unknown) => callbacks.push({ error, data }),
    });
    expect(callbacks).toHaveLength(1);
    expect(callbacks[0].error).toBeUndefined();
    states.push(digest(await fsp.readFile(archive)));
    return callbacks[0].data;
  };
  expect(await invoke("qbmsList")).toEqual([
    { offset: "0000000000000008", size: "4", filePath: "Payload/Value with space.txt" },
  ]);
  await expect(fsp.stat(payload)).rejects.toMatchObject({ code: "ENOENT" });
  await invoke("qbmsExtract", { overwrite: true, wildCards: ["{}"] });
  expect(await fsp.readFile(payload, "utf8")).toBe("base");
  await fsp.writeFile(payload, "mod!");
  await invoke("qbmsReimport", { allowResize: false, overwrite: true });
  const replaced = Buffer.from(original);
  replaced.write("mod!", 8);
  expect(await fsp.readFile(archive)).toEqual(replaced);
  await fsp.writeFile(payload, "larger payload!");
  await invoke("qbmsReimport", { allowResize: true, overwrite: true });
  const resized = await fsp.readFile(archive);
  expect(
    resized
      .subarray(resized.readUInt32LE(0), resized.readUInt32LE(0) + resized.readUInt32LE(4))
      .toString(),
  ).toBe("larger payload!");
  const writeScript = path.join(root, "write.bms");
  await fsp.writeFile(writeScript, "put 0x11223344 long\n");
  await invoke("qbmsWrite", {}, writeScript);
  expect((await fsp.readFile(archive)).readUInt32LE(0)).toBe(0x11223344);
  expect(states).toEqual([
    "3cce77affde434eb7936f1bf551dd1e072ce16b1ebc3e7c9a32796af49a15e83",
    "3cce77affde434eb7936f1bf551dd1e072ce16b1ebc3e7c9a32796af49a15e83",
    "b02b18e366897eb0e6a2c63a0bc7529a4ced87c9c903317602551a6cf93f07bc",
    "d3310816f97de0f9a42419b2ca75e0b20d88d85404d47b6dde0e0e3288315bc1",
    "e597c02c068017a6bd9b340e120984d4edad840909aade13d7f87698676920e7",
  ]);
  expect(calls).toHaveLength(5);
  for (const call of calls) {
    expect(call.command).toBe(executable);
    expect(call.options.shell).toBe(false);
    expect(call.args).toContain(archive);
  }
}, 20_000);
