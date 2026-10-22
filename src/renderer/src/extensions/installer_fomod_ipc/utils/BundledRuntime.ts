import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";

import SevenZip from "node-7z";

export interface IRuntimeBundlePin {
  archiveName: string;
  archiveSha256: string;
  manifestName: string;
  manifestSha256: string;
}

interface IBundleEntry {
  path: string;
  sha256: string;
  bytes: number;
  mode: number;
}

export interface INativeFomodRuntime {
  root: string;
  mono: string;
  helper: string;
  config: string;
}

type ExtractArchive = (archive: string, destination: string) => Promise<unknown>;
const inFlight = new Map<string, Promise<INativeFomodRuntime>>();
const sha256Pattern = /^[a-f0-9]{64}$/;
const requiredFiles = [
  "usr/bin/mono-sgen",
  "usr/bin/mcs",
  "usr/lib/mono/4.5/mcs.exe",
  "usr/lib/mono/4.5/mscorlib.dll",
  "usr/lib/libgdiplus.so.0",
  "etc/mono/config",
];

async function hashFile(file: string): Promise<string> {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error(`Not a regular runtime file: ${file}`);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function safeRelativeFile(file: unknown): file is string {
  return (
    typeof file === "string" &&
    file.length > 0 &&
    file.length < 512 &&
    !file.includes("\\") &&
    !file.includes(":") &&
    !file.includes("\0") &&
    !file.startsWith("/") &&
    file.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function validateEntries(value: unknown): IBundleEntry[] {
  if (!Array.isArray(value) || value.length < requiredFiles.length || value.length > 10000) {
    throw new Error("Invalid native FOMOD bundle file list");
  }
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const entry of value) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !safeRelativeFile(entry.path) ||
      seen.has(entry.path) ||
      typeof entry.sha256 !== "string" ||
      !sha256Pattern.test(entry.sha256) ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0 ||
      entry.bytes > 64 * 1024 * 1024 ||
      ![0o644, 0o755].includes(entry.mode)
    )
      throw new Error("Invalid native FOMOD bundle entry");
    seen.add(entry.path);
    totalBytes += entry.bytes;
  }
  if (totalBytes > 1024 * 1024 * 1024 || requiredFiles.some((file) => !seen.has(file))) {
    throw new Error("Incomplete or oversized native FOMOD bundle");
  }
  return value;
}

async function readEntries(assets: string, pin: IRuntimeBundlePin): Promise<IBundleEntry[]> {
  for (const name of [pin.archiveName, pin.manifestName]) {
    if (!safeRelativeFile(name) || name.includes("/"))
      throw new Error("Invalid runtime asset name");
  }
  if (!sha256Pattern.test(pin.archiveSha256) || !sha256Pattern.test(pin.manifestSha256)) {
    throw new Error("Invalid native FOMOD bundle pin");
  }
  const manifest = path.join(assets, pin.manifestName);
  const stat = await fs.lstat(manifest);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) {
    throw new Error("Invalid native FOMOD manifest");
  }
  const bytes = await fs.readFile(manifest);
  if (createHash("sha256").update(bytes).digest("hex") !== pin.manifestSha256) {
    throw new Error("Native FOMOD manifest checksum mismatch");
  }
  const data = JSON.parse(bytes.toString("utf8"));
  if (
    data.schemaVersion !== 1 ||
    data.archiveLayout !== "sha256-objects" ||
    data.platform !== "linux" ||
    data.arch !== "x64"
  ) {
    throw new Error("Unsupported native FOMOD bundle format");
  }
  return validateEntries(data.entries);
}

async function listRegularFiles(root: string, relative = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error("Native FOMOD cache contains a symbolic link");
    if (entry.isDirectory()) files.push(...(await listRegularFiles(root, child)));
    else if (entry.isFile()) files.push(child);
    else throw new Error("Native FOMOD cache contains a non-regular file");
  }
  return files;
}

async function verifyTree(root: string, entries: IBundleEntry[]): Promise<void> {
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Invalid native FOMOD cache directory");
  const files = new Set(await listRegularFiles(root));
  if (files.size !== entries.length) throw new Error("Native FOMOD cache file list mismatch");
  for (const entry of entries) {
    const file = path.join(root, entry.path);
    const info = await fs.lstat(file);
    if (
      !files.has(entry.path) ||
      info.size !== entry.bytes ||
      (await hashFile(file)) !== entry.sha256
    ) {
      throw new Error(`Native FOMOD runtime checksum mismatch: ${entry.path}`);
    }
    if (process.platform !== "win32" && (info.mode & 0o7777) !== entry.mode) {
      throw new Error(`Native FOMOD runtime permissions mismatch: ${entry.path}`);
    }
  }
}

async function materialize(
  objectsRoot: string,
  output: string,
  entries: IBundleEntry[],
): Promise<void> {
  const sizes = new Map(entries.map((entry) => [entry.sha256, entry.bytes]));
  const objects = await listRegularFiles(objectsRoot);
  if (
    objects.length !== sizes.size ||
    objects.some((file) => !/^objects\/[a-f0-9]{64}$/.test(file))
  ) {
    throw new Error("Unexpected native FOMOD archive contents");
  }
  for (const [sha256, size] of sizes) {
    const file = path.join(objectsRoot, "objects", sha256);
    if ((await fs.lstat(file)).size !== size || (await hashFile(file)) !== sha256) {
      throw new Error("Native FOMOD archive object checksum mismatch");
    }
  }
  const copies = new Map<string, string>();
  for (const entry of entries) {
    const target = path.join(output, entry.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const key = `${entry.sha256}-${entry.mode}`;
    const existing = copies.get(key);
    if (existing !== undefined) await fs.link(existing, target);
    else {
      await fs.copyFile(path.join(objectsRoot, "objects", entry.sha256), target);
      await fs.chmod(target, entry.mode);
      copies.set(key, target);
    }
  }
}

/** The helper's Mono build ships beside the runtime archive, from @nexusmods/fomod-installer-ipc. */
function helperPath(assets: string): string {
  return path.join(assets, "helper", "ModInstallerIPC.exe");
}

function describeRuntime(root: string, assets: string): INativeFomodRuntime {
  return {
    root,
    mono: path.join(root, "usr/bin/mono-sgen"),
    helper: helperPath(assets),
    config: path.join(root, "etc/mono/config"),
  };
}

async function installBundle(
  assets: string,
  base: string,
  pin: IRuntimeBundlePin,
  entries: IBundleEntry[],
  extract: ExtractArchive,
): Promise<INativeFomodRuntime> {
  const target = path.join(base, pin.manifestSha256);
  try {
    const stat = await fs.lstat(target);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Invalid native FOMOD cache target");
    try {
      await verifyTree(target, entries);
      return describeRuntime(target, assets);
    } catch {
      // Retain a damaged private runtime for diagnosis, then automatically replace it.
      await fs.rename(target, `${target}.invalid-${randomUUID()}`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const archive = path.join(assets, pin.archiveName);
  if ((await hashFile(archive)) !== pin.archiveSha256)
    throw new Error("Native FOMOD archive checksum mismatch");
  const temporary = await fs.mkdtemp(path.join(base, ".stage-"));
  try {
    const objects = path.join(temporary, "objects");
    const tree = path.join(temporary, "runtime");
    await fs.mkdir(objects);
    await fs.mkdir(tree);
    await extract(archive, objects);
    await materialize(objects, tree, entries);
    await verifyTree(tree, entries);
    try {
      await fs.rename(tree, target);
    } catch (err) {
      if (!["EEXIST", "ENOTEMPTY"].includes((err as NodeJS.ErrnoException).code)) throw err;
      await verifyTree(target, entries);
    }
    return describeRuntime(target, assets);
  } finally {
    // This path was created by mkdtemp under the canonical private cache base.
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

/** Called only after the C# trust boundary; no system installation or administrator rights. */
export async function prepareNativeRuntime(
  assets: string,
  cacheDirectory: string,
  pin: IRuntimeBundlePin,
  extract: ExtractArchive = async (archive, destination) =>
    await new SevenZip().extractFull(archive, destination),
): Promise<INativeFomodRuntime> {
  const entries = await readEntries(assets, pin);
  const helper = await fs.lstat(helperPath(assets)).catch(() => undefined);
  if (helper === undefined || !helper.isFile() || helper.isSymbolicLink())
    throw new Error("The native FOMOD helper is missing from this Vortex build");
  await fs.mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(cacheDirectory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Invalid native FOMOD cache base");
  const base = await fs.realpath(cacheDirectory);
  const key = path.join(base, pin.manifestSha256);
  const pending = inFlight.get(key);
  if (pending !== undefined) return pending;
  const work = installBundle(assets, base, pin, entries, extract);
  inFlight.set(key, work);
  try {
    return await work;
  } finally {
    if (inFlight.get(key) === work) inFlight.delete(key);
  }
}
