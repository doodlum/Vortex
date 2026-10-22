import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";

export function within(root, target) {
  const relative = path.relative(root, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Resolve existing ancestors before creating a new build/cache directory. */
export async function newPath(value) {
  let current = path.resolve(value);
  const suffix = [];
  for (;;) {
    try {
      return path.join(await fs.realpath(current), ...suffix);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

export async function hashFile(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/** Record physical files, executable bits and link targets without following directory links. */
export async function readTree(directory) {
  const root = await fs.realpath(directory);
  const entries = {};
  async function visit(current) {
    const children = await fs.readdir(current, { withFileTypes: true });
    children.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const child of children) {
      const file = path.join(current, child.name);
      const name = path.relative(root, file).split(path.sep).join("/");
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink()) {
        const resolved = await fs.realpath(file);
        if (!within(root, resolved)) throw new Error(`Package symlink leaves its tree: ${name}`);
        entries[name] = { type: "symlink", target: await fs.readlink(file) };
      } else if (stat.isDirectory()) {
        await visit(file);
      } else if (stat.isFile()) {
        entries[name] = {
          type: "file",
          bytes: stat.size,
          sha256: await hashFile(file),
          executable: (stat.mode & 0o111) !== 0,
        };
      } else {
        throw new Error(`Unsupported package entry: ${name}`);
      }
    }
  }
  await visit(root);
  return entries;
}

export function treeDigest(entries) {
  return createHash("sha256")
    .update(
      JSON.stringify(
        Object.entries(entries).sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0,
        ),
      ),
    )
    .digest("hex");
}

/** Snapshot before building, so every target reads the same bytes. Keep internal links relative. */
export async function copyTree(sourceDirectory, destination) {
  const source = await fs.realpath(sourceDirectory);
  const target = await newPath(destination);
  if (within(source, target) || within(target, source))
    throw new Error("Package snapshot must be separate from its input");
  const before = await readTree(source);
  await fs.mkdir(destination);
  await fs.cp(source, destination, {
    recursive: true,
    verbatimSymlinks: true,
    preserveTimestamps: true,
  });
  for (const [name, entry] of Object.entries(before)) {
    if (entry.type !== "symlink" || !path.isAbsolute(entry.target)) continue;
    const link = path.join(destination, name);
    const resolved = await fs.realpath(path.join(source, name));
    if (!within(source, resolved)) throw new Error(`Package symlink leaves its tree: ${name}`);
    const relocated = path.join(destination, path.relative(source, resolved));
    await fs.unlink(link);
    await fs.symlink(
      path.relative(path.dirname(link), relocated),
      link,
      (await fs.stat(resolved)).isDirectory() ? "dir" : "file",
    );
  }
  if (treeDigest(await readTree(source)) !== treeDigest(before))
    throw new Error("Package input changed while making its snapshot");
  const after = await readTree(destination);
  const normalized = structuredClone(before);
  for (const [name, entry] of Object.entries(normalized)) {
    if (entry.type === "symlink" && path.isAbsolute(entry.target)) {
      entry.target = path.relative(
        path.dirname(path.join(destination, name)),
        path.join(destination, path.relative(source, await fs.realpath(path.join(source, name)))),
      );
    }
  }
  if (treeDigest(normalized) !== treeDigest(after))
    throw new Error("Package snapshot differs from its input");
  return { original: before, snapshot: after };
}

export async function writeJson(file, value) {
  const temporary = `${file}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
  await fs.rename(temporary, file);
}

/** Identify the executable selected by PATH as well as its reported version. */
export async function toolIdentity(command, args, env) {
  let executable;
  const candidates = path.isAbsolute(command)
    ? [command]
    : (env.PATH ?? "").split(path.delimiter).map((directory) => path.resolve(directory, command));
  for (const candidate of candidates) {
    try {
      await fs.access(candidate, fs.constants.X_OK);
      if ((await fs.stat(candidate)).isFile()) {
        executable = await fs.realpath(candidate);
        break;
      }
    } catch (error) {
      if (!["ENOENT", "EACCES", "ENOTDIR"].includes(error.code)) throw error;
    }
  }
  if (!executable) throw new Error(`Missing packaging tool: ${command}`);
  const version = execFileSync(executable, args, { env, encoding: "utf8", timeout: 30_000 }).trim();
  return { executable, sha256: await hashFile(executable), version };
}
