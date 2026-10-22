import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { runCommand } from "./linux-package-command.mjs";
import { hashFile, readTree, treeDigest, toolIdentity, writeJson } from "./linux-package-files.mjs";

export function parseFpmLock(bytes) {
  const lock = JSON.parse(bytes);
  if (
    lock.version !== "1.18.0" ||
    lock.registry !== "https://rubygems.org/downloads/" ||
    !Array.isArray(lock.gems) ||
    lock.gems.length === 0
  )
    throw new Error("Unsupported FPM tool lock");
  const names = new Set();
  for (const gem of lock.gems) {
    if (
      !/^[a-z][a-z0-9-]*$/.test(gem.name) ||
      !/^\d+(\.\d+)*$/.test(gem.version) ||
      !/^[a-f0-9]{64}$/.test(gem.sha256) ||
      names.has(gem.name)
    )
      throw new Error("Invalid FPM gem pin");
    names.add(gem.name);
  }
  if (!lock.gems.some((gem) => gem.name === "fpm" && gem.version === lock.version))
    throw new Error("FPM version is absent from its tool lock");
  return lock;
}

function gemEnvironment(directory, env) {
  const result = {
    ...env,
    GEM_HOME: path.join(directory, "gems"),
    GEM_PATH: path.join(directory, "gems"),
  };
  for (const key of ["RUBYOPT", "RUBYLIB", "GEM_SPEC_CACHE", "BUNDLE_GEMFILE", "BUNDLE_PATH"])
    delete result[key];
  return result;
}

/** Download only lock-pinned files; RubyGems resolution and network installation stay disabled. */
export async function downloadGem(gem, registry, destination, fetchArchive = fetch) {
  const response = await fetchArchive(`${registry}${gem.name}-${gem.version}.gem`, {
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok || !response.body)
    throw new Error(`Cannot download pinned gem ${gem.name}: ${response.status}`);
  await pipeline(
    Readable.fromWeb(response.body),
    createWriteStream(destination, { flags: "wx", mode: 0o600 }),
  );
  if ((await hashFile(destination)) !== gem.sha256) {
    await fs.unlink(destination);
    throw new Error(`Checksum mismatch for pinned gem ${gem.name}`);
  }
}

/** An atomically published, independently validated cache; never install gems into system directories. */
export async function prepareFpm({
  cacheDirectory,
  env,
  lockPath = new URL("./linux-fpm-lock.json", import.meta.url),
  run = runCommand,
}) {
  const bytes = await fs.readFile(lockPath);
  const lock = parseFpmLock(bytes);
  const lockSha256 = createHash("sha256").update(bytes).digest("hex");
  const parent = path.resolve(cacheDirectory);
  const probeEnv = gemEnvironment(parent, env);
  let ruby;
  let rubyGems;
  try {
    ruby = await toolIdentity("ruby", ["--version"], probeEnv);
    rubyGems = await toolIdentity("gem", ["--version"], probeEnv);
  } catch (cause) {
    throw new Error("Native Linux packages require Ruby and RubyGems on the build machine", {
      cause,
    });
  }
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const directory = path.join(parent, `fpm-${lockSha256}`);
  async function validate() {
    const receipt = JSON.parse(await fs.readFile(path.join(directory, "receipt.json"), "utf8"));
    if (
      receipt.lockSha256 !== lockSha256 ||
      JSON.stringify(receipt.ruby) !== JSON.stringify(ruby) ||
      JSON.stringify(receipt.rubyGems) !== JSON.stringify(rubyGems) ||
      treeDigest(await readTree(path.join(directory, "gems"))) !== receipt.installedTreeSha256 ||
      treeDigest(await readTree(path.join(directory, "bin"))) !== receipt.binTreeSha256
    )
      throw new Error(`FPM cache is inconsistent; inspect ${directory} before rebuilding it`);
    for (const gem of lock.gems) {
      if (
        (await hashFile(path.join(directory, "archives", `${gem.name}-${gem.version}.gem`))) !==
        gem.sha256
      )
        throw new Error(`FPM archive cache is inconsistent: ${gem.name}`);
    }
    const version = execFileSync(path.join(directory, "bin", "fpm"), ["--version"], {
      env: gemEnvironment(directory, env),
      encoding: "utf8",
      timeout: 30_000,
    }).trim();
    if (version !== lock.version) throw new Error(`Unexpected FPM version in ${directory}`);
    return {
      env: {
        ...gemEnvironment(directory, env),
        USE_SYSTEM_FPM: "true",
        PATH: `${path.join(directory, "bin")}${path.delimiter}${env.PATH ?? ""}`,
      },
      lockSha256,
      version,
      ruby,
      rubyGems,
    };
  }
  try {
    await fs.lstat(directory);
    return await validate();
  } catch (error) {
    if (error.code !== "ENOENT" || error.path !== directory) throw error;
  }
  const staging = await fs.mkdtemp(path.join(parent, "fpm-setup-"));
  const archives = path.join(staging, "archives");
  await fs.mkdir(archives);
  const files = [];
  for (const gem of lock.gems) {
    const file = path.join(archives, `${gem.name}-${gem.version}.gem`);
    await downloadGem(gem, lock.registry, file);
    files.push(file);
  }
  await run(
    "gem",
    [
      "install",
      "--norc",
      "--local",
      "--ignore-dependencies",
      "--no-document",
      "--install-dir",
      path.join(staging, "gems"),
      "--bindir",
      path.join(staging, "bin"),
      ...files,
    ],
    {
      cwd: staging,
      env: gemEnvironment(staging, env),
      log: path.join(staging, "install.log"),
      timeoutMs: 300_000,
    },
  );
  await writeJson(path.join(staging, "receipt.json"), {
    lockSha256,
    ruby,
    rubyGems,
    installedTreeSha256: treeDigest(await readTree(path.join(staging, "gems"))),
    binTreeSha256: treeDigest(await readTree(path.join(staging, "bin"))),
  });
  try {
    await fs.rename(staging, directory);
  } catch (error) {
    if (!["ENOTEMPTY", "EEXIST"].includes(error.code)) throw error;
    // Another complete setup can win publication; retain our private staging evidence.
  }
  return validate();
}
