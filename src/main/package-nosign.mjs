import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

function within(root, target) {
  const relative = path.relative(root, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function assertIsolatedParent(directory) {
  for (let current = directory; ; current = path.dirname(current)) {
    const modules = path.join(current, "node_modules");
    try {
      await fs.lstat(modules);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (path.dirname(current) === current) return;
      continue;
    }
    throw new Error(
      `Linux packaging scratch directory has an ancestor dependency tree: ${modules}`,
    );
  }
}

/** Preserve config paths outside the deployed tree when copying that tree elsewhere. */
function stagedConfig(config, deploy) {
  const external = (value) => {
    const absolute = path.resolve(deploy, value);
    return within(deploy, absolute) ? value : absolute;
  };
  const result = structuredClone(config);
  result.directories.output = path.resolve(deploy, config.directories.output);
  if (result.linux?.icon) result.linux.icon = external(result.linux.icon);
  result.extraResources = result.extraResources?.map((entry) =>
    typeof entry === "string" ? external(entry) : { ...entry, from: external(entry.from) },
  );
  result.extraFiles = result.extraFiles?.map((entry) =>
    typeof entry === "string" ? external(entry) : { ...entry, from: external(entry.from) },
  );
  return result;
}

/** Create a private copy so the pinned dependency collector cannot traverse the checkout. */
export async function stageLinuxPackage(deployDirectory, temporaryRoot) {
  const deploy = await fs.realpath(deployDirectory);
  const parent = await fs.realpath(temporaryRoot);
  await assertIsolatedParent(parent);
  const temporary = await fs.mkdtemp(path.join(parent, "vortex-linux-package-"));
  const stage = path.join(temporary, "dist");
  try {
    // Preserve relative links while copying; absolute internal links are relocated below.
    await fs.cp(deploy, stage, {
      recursive: true,
      verbatimSymlinks: true,
      mode: constants.COPYFILE_FICLONE,
    });
    const entries = await fs.readdir(stage, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isSymbolicLink()) continue;
      const link = path.join(entry.parentPath, entry.name);
      const source = path.join(deploy, path.relative(stage, link));
      const sourceTarget = await fs.realpath(source);
      if (!within(deploy, sourceTarget))
        throw new Error(`Deployed package symlink leaves its dependency tree: ${source}`);
      // Resolve the original chain before relocation: lexical '..' checks can miss
      // a link that traverses an internal alias and then escapes its root.
      const destination = path.join(stage, path.relative(deploy, sourceTarget));
      await fs.unlink(link);
      await fs.symlink(path.relative(path.dirname(link), destination), link);
    }
    const configFile = path.join(stage, "electron-builder.config.json");
    const config = JSON.parse(await fs.readFile(configFile, "utf8"));
    await fs.writeFile(configFile, JSON.stringify(stagedConfig(config, deploy), null, 2) + "\n");
    return { parent, temporary, stage, configFile };
  } catch (error) {
    console.error(`Failed Linux packaging inputs retained at ${temporary}`);
    throw error;
  }
}

function run(command, args, options) {
  const result = spawnSync(command, args, { ...options, stdio: "inherit" });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

/** Root package:nosign prepares the deployment first; this entry only invokes the packager. */
export async function packageUnsigned(options = {}) {
  const deploy = path.resolve(options.deploy ?? path.join(import.meta.dirname, "dist"));
  const platform = options.platform ?? process.platform;
  const invoke = options.run ?? run;
  if (platform !== "linux") {
    return invoke(
      "pnpm",
      ["electron-builder", "--config", "./electron-builder.config.json", "--publish", "never"],
      { cwd: deploy, shell: platform === "win32" },
    );
  }
  const require = createRequire(path.join(deploy, "package.json"));
  const builderPackage = require.resolve("electron-builder/package.json");
  const builder = JSON.parse(await fs.readFile(builderPackage, "utf8"));
  const cli = path.resolve(path.dirname(builderPackage), builder.bin["electron-builder"]);
  const staged = await stageLinuxPackage(
    deploy,
    options.temporaryRoot ?? process.env.VORTEX_LINUX_PACKAGE_TMPDIR ?? "/var/tmp",
  );
  console.log(`Isolated Linux packaging inputs: ${staged.stage}`);
  // Only remove the exact private directory returned by mkdtemp.
  if (
    path.dirname(staged.temporary) !== staged.parent ||
    !path.basename(staged.temporary).startsWith("vortex-linux-package-")
  )
    throw new Error("Packaging cleanup target escaped its scratch directory");
  let code;
  try {
    code = await invoke(
      process.execPath,
      [cli, "--config", staged.configFile, "--publish", "never"],
      { cwd: staged.stage, shell: false },
    );
  } finally {
    if (code === 0) {
      await fs.rm(staged.temporary, { recursive: true, force: true });
    } else {
      console.error(`Failed Linux packaging inputs retained at ${staged.temporary}`);
    }
  }
  return code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await packageUnsigned();
}
