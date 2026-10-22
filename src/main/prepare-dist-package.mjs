import { createWriteStream, existsSync } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const MAIN_DIR = resolve(import.meta.dirname);
const MAIN_PACKAGE_PATH = resolve(MAIN_DIR, "package.json");
const DIST_DIR = resolve(MAIN_DIR, "build");
const DIST_PACKAGE_PATH = resolve(DIST_DIR, "package.json");
// Runtimes bundled into the installer; also declared as winget dependencies by winget-release.yml.
const RUNTIME_DEPS_FILE = "runtime-dependencies.json";

// Walks up because MAIN_DIR is the pnpm-deployed copy (src/main/dist), not src/main.
function findUp(fileName, from) {
  let dir = from;
  for (;;) {
    const candidate = resolve(dir, fileName);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`Could not find ${fileName} above ${from}`);
    dir = parent;
  }
}

async function resolveDepVersions(deps, nodeModulesDir) {
  if (!deps) return deps;
  const resolved = { ...deps };
  for (const [name, version] of Object.entries(deps)) {
    if (version === "catalog:" || version.startsWith("workspace:")) {
      try {
        const pkgJson = JSON.parse(
          await readFile(resolve(nodeModulesDir, name, "package.json"), "utf8"),
        );
        resolved[name] = pkgJson.version;
      } catch {
        // leave as-is if not found in node_modules
      }
    }
  }
  return resolved;
}

async function downloadFile(url, dest) {
  await mkdir(resolve(dest, ".."), { recursive: true });
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download ${url}: ${response.statusText}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(dest));
}

async function prepareWin() {
  // assert that loot runtime assets exist; fail the build if they don't.
  const lootRelease = resolve(DIST_DIR, "assets", "loot", "build", "Release");
  for (const file of ["node-loot.node", "libloot.dll"]) {
    await access(resolve(lootRelease, file)).catch(() => {
      throw new Error(`missing loot runtime asset: ${resolve(lootRelease, file)}`);
    });
  }

  const tempDir = resolve(MAIN_DIR, "temp");
  const runtimeDeps = JSON.parse(await readFile(findUp(RUNTIME_DEPS_FILE, MAIN_DIR), "utf8"));
  for (const { file, url } of runtimeDeps) {
    await downloadFile(url, resolve(tempDir, file));
  }
}

async function main() {
  const json = await readFile(MAIN_PACKAGE_PATH, "utf8");
  const mainPkg = JSON.parse(json);

  mainPkg["name"] = "Vortex";
  // Electron derives the Linux desktop name -- and from it the Wayland app_id and X11 WM_CLASS --
  // from this field, falling back to a slug of `name`, which yields "vortex". A desktop environment
  // then looks for a vortex.desktop to take the window icon from, finds none (the installed entry is
  // com.nexusmods.vortex.desktop) and shows a generic placeholder in the taskbar instead of Vortex's
  // logo. Setting it explicitly makes the app_id, the installed desktop file and the id used for
  // nxm:// registration agree. It does NOT affect app.getPath("userData"), which comes from `name`.
  if (process.platform === "linux") {
    mainPkg["desktopName"] = "com.nexusmods.vortex.desktop";
    // Native Linux package formats require these fields after pnpm deploy.
    mainPkg["homepage"] ??= "https://www.nexusmods.com/about/vortex";
    mainPkg["description"] ??=
      "The elegant, powerful, and open-source mod manager from Nexus Mods.";
  }
  mainPkg["main"] = mainPkg.main.replace(/^build\//, "");

  // NOTE(erri120): this is the minimal amount of bullshit required to get the piece of shit software called "electron-builder" to work with PNPM.
  const nodeModulesDir = resolve(MAIN_DIR, "node_modules");
  mainPkg.dependencies = await resolveDepVersions(mainPkg.dependencies, nodeModulesDir);
  mainPkg.devDependencies = await resolveDepVersions(mainPkg.devDependencies, nodeModulesDir);
  mainPkg.optionalDependencies = await resolveDepVersions(
    mainPkg.optionalDependencies,
    nodeModulesDir,
  );

  await writeFile(DIST_PACKAGE_PATH, JSON.stringify(mainPkg, null, 2) + "\n", "utf8");

  if (process.platform === "win32") {
    await prepareWin();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
