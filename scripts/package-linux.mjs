import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { prepareFpm } from "./linux-fpm.mjs";
import { runCommand } from "./linux-package-command.mjs";
import {
  copyTree,
  hashFile,
  newPath,
  readTree,
  treeDigest,
  toolIdentity,
  within,
  writeJson,
} from "./linux-package-files.mjs";

export const FORMATS = ["deb", "rpm", "pacman", "AppImage", "snap", "flatpak", "tar.gz"];
export const FLATPAK_LAUNCHER = '#!/bin/sh\nexec zypak-wrapper /app/main/vortex "$@"\n';
export const SNAP_LAUNCHER = '#!/bin/sh\nexec "$SNAP/app/vortex" "$@"\n';
const APP_ID = "com.nexusmods.vortex";
const DESCRIPTION = "Mod manager for PC games from Nexus Mods";
const ROOT = path.resolve(import.meta.dirname, "..");

// Reserve 78 bytes for the protocol alias and its atomic temporary suffix
// on filesystems with 255-byte filename components. IDs below are ASCII only.
function flatpakApplicationId(value) {
  if (
    typeof value !== "string" ||
    value.length > 177 ||
    !/^[A-Za-z][A-Za-z0-9_]*\.(?:[A-Za-z_][A-Za-z0-9_]*\.)+[A-Za-z_][A-Za-z0-9_-]*$/.test(value)
  )
    throw new Error("Invalid Flatpak application ID");
  return value;
}

export function parseOptions(args, root = ROOT) {
  const options = {
    root,
    input: path.join(root, "dist/linux-unpacked"),
    deploy: path.join(root, "src/main/dist"),
    output: path.join(root, "dist/linux-packages"),
    cache: path.join(root, "dist/linux-package-tools"),
    formats: [...FORMATS],
    snapName: "vortex",
    flatpakBranch: "development",
    flatpakId: APP_ID,
    help: false,
  };
  const paths = {
    "--input": "input",
    "--deploy": "deploy",
    "--output": "output",
    "--tool-cache": "cache",
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--help") {
      options.help = true;
      continue;
    }
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
    if (paths[arg]) options[paths[arg]] = path.resolve(value);
    else if (arg === "--formats") {
      options.formats = value.split(",");
      if (
        !options.formats.length ||
        options.formats.some((format) => !FORMATS.includes(format)) ||
        new Set(options.formats).size !== options.formats.length
      )
        throw new Error(`Select distinct formats from ${FORMATS.join(",")}`);
    } else if (arg === "--snap-name") options.snapName = value;
    else if (arg === "--flatpak-branch") options.flatpakBranch = value;
    else if (arg === "--flatpak-app-id") options.flatpakId = flatpakApplicationId(value);
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!/^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){1,39}$/.test(options.snapName))
    throw new Error("Invalid Snap name");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(options.flatpakBranch))
    throw new Error("Invalid Flatpak branch");
  return options;
}

function singleLine(value) {
  if (typeof value !== "string" || !value || /[\r\n\0]/.test(value))
    throw new Error("Invalid package metadata");
  return value;
}

export function desktopEntry(exec, icon, desktopId = APP_ID) {
  return `[Desktop Entry]\nType=Application\nName=Vortex\nComment=${DESCRIPTION}\nExec=${singleLine(exec)}\nIcon=${singleLine(icon)}\nTerminal=false\nCategories=Game;\nMimeType=x-scheme-handler/nxm;\nStartupWMClass=${singleLine(desktopId)}\n`;
}

export function flatpakManifest({
  branch,
  appId = APP_ID,
  payload,
  wrapper,
  desktop,
  icon,
  metainfo,
}) {
  singleLine(branch);
  flatpakApplicationId(appId);
  return {
    "app-id": appId,
    runtime: "org.freedesktop.Platform",
    "runtime-version": "25.08",
    sdk: "org.freedesktop.Sdk",
    base: "org.electronjs.Electron2.BaseApp",
    "base-version": "25.08",
    command: "vortex",
    "separate-locales": false,
    "finish-args": [
      "--share=ipc",
      "--socket=x11",
      "--socket=wayland",
      "--socket=pulseaudio",
      "--device=dri",
      "--allow=multiarch",
      "--share=network",
      "--filesystem=host",
      "--talk-name=org.kde.StatusNotifierWatcher",
      "--system-talk-name=org.freedesktop.UDisks2",
      "--talk-name=org.freedesktop.Flatpak",
      "--env=IGNORE_UPDATES=yes",
      "--env=IS_FLATPAK=true",
      "--env=ELECTRON_TRASH=gio",
    ],
    modules: [
      {
        name: "vortex",
        buildsystem: "simple",
        "build-options": { "no-debuginfo": true, strip: false },
        "build-commands": [
          "install -d /app/main",
          "cp -a payload/. /app/main/",
          "install -Dm755 vortex /app/bin/vortex",
          `install -Dm644 ${appId}.desktop /app/share/applications/${appId}.desktop`,
          `install -Dm644 icon.png /app/share/icons/hicolor/256x256/apps/${appId}.png`,
          `install -Dm644 ${appId}.metainfo.xml /app/share/metainfo/${appId}.metainfo.xml`,
        ],
        sources: [
          { type: "dir", path: payload, dest: "payload" },
          ...[
            [wrapper, "vortex"],
            [desktop, `${appId}.desktop`],
            [icon, "icon.png"],
            [metainfo, `${appId}.metainfo.xml`],
          ].map(([file, name]) => ({ type: "file", path: file, "dest-filename": name })),
        ],
      },
    ],
  };
}

export function snapMetadata({ name, version, license }) {
  return {
    name,
    version,
    summary: DESCRIPTION,
    description: `${DESCRIPTION}. Development package.`,
    base: "core24",
    architectures: ["amd64"],
    confinement: "classic",
    grade: "devel",
    license,
    apps: { [name]: { command: "bin/vortex", desktop: "meta/gui/vortex.desktop" } },
  };
}

function xml(value) {
  return singleLine(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function makeFlatpak(directory, payload, icon, metadata, options, env, run) {
  const appId = flatpakApplicationId(options.flatpakId);
  await fs.mkdir(directory);
  const wrapper = path.join(directory, "vortex");
  await fs.writeFile(wrapper, FLATPAK_LAUNCHER);
  const desktop = path.join(directory, `${appId}.desktop`);
  await fs.writeFile(desktop, desktopEntry("vortex %u", appId, appId));
  const metainfo = path.join(directory, `${appId}.metainfo.xml`);
  await fs.writeFile(
    metainfo,
    `<?xml version="1.0" encoding="UTF-8"?>\n<component type="desktop-application"><id>${appId}</id><metadata_license>CC0-1.0</metadata_license><project_license>${xml(metadata.license)}</project_license><name>Vortex</name><summary>${DESCRIPTION}</summary><description><p>Manage mods and game profiles with Vortex from Nexus Mods.</p></description><developer id="com.nexusmods"><name>Black Tree Gaming Ltd.</name></developer><url type="homepage">${xml(metadata.homepage)}</url><launchable type="desktop-id">${appId}.desktop</launchable><provides><binary>vortex</binary></provides><content_rating type="oars-1.1"/></component>\n`,
  );
  const manifest = path.join(directory, "manifest.json");
  await writeJson(
    manifest,
    flatpakManifest({
      branch: options.flatpakBranch,
      appId,
      payload,
      wrapper,
      desktop,
      icon,
      metainfo,
    }),
  );
  const repo = path.join(directory, "repo");
  const commits = {};
  for (const id of [
    "org.freedesktop.Platform",
    "org.freedesktop.Sdk",
    "org.electronjs.Electron2.BaseApp",
  ]) {
    commits[id] = execFileSync("flatpak", ["info", "--user", "--show-commit", `${id}//25.08`], {
      env,
      encoding: "utf8",
      timeout: 30_000,
    }).trim();
  }
  await writeJson(path.join(directory, "runtime-commits.json"), commits);
  await run(
    "flatpak-builder",
    ["--user", `--repo=${repo}`, `--default-branch=${options.flatpakBranch}`, "build", manifest],
    { cwd: directory, env, log: path.join(directory, "build.log") },
  );
  const packaged = await readTree(path.join(directory, "build/files/main"));
  if (treeDigest(packaged) !== treeDigest(await readTree(payload)))
    throw new Error("Flatpak altered the common application payload");
  const artifact = path.join(directory, `vortex-${metadata.version}-x86_64.flatpak`);
  await run(
    "flatpak",
    [
      "build-bundle",
      repo,
      artifact,
      appId,
      options.flatpakBranch,
      "--runtime-repo=https://flathub.org/repo/flathub.flatpakrepo",
    ],
    { cwd: directory, env, log: path.join(directory, "bundle.log") },
  );
}

async function makeSnap(directory, payload, icon, metadata, options, env, run) {
  await fs.mkdir(directory);
  const stage = path.join(directory, "stage");
  await fs.mkdir(stage);
  await copyTree(payload, path.join(stage, "app"));
  await fs.mkdir(path.join(stage, "bin"));
  await fs.mkdir(path.join(stage, "meta/gui"), { recursive: true });
  await fs.writeFile(path.join(stage, "bin/vortex"), SNAP_LAUNCHER, { mode: 0o755 });
  await fs.copyFile(icon, path.join(stage, "meta/gui/icon.png"));
  await fs.writeFile(
    path.join(stage, "meta/gui/vortex.desktop"),
    desktopEntry(`${options.snapName} %u`, "${SNAP}/meta/gui/icon.png"),
  );
  // JSON is a YAML subset; avoid introducing a separate YAML serializer for snapd metadata.
  await writeJson(
    path.join(stage, "meta/snap.yaml"),
    snapMetadata({ name: options.snapName, version: metadata.version, license: metadata.license }),
  );
  await run("snap", ["pack", "--check-skeleton", stage], {
    cwd: directory,
    env,
    log: path.join(directory, "validate.log"),
  });
  await run("snap", ["pack", stage, directory, "--compression=xz"], {
    cwd: directory,
    env,
    log: path.join(directory, "build.log"),
  });
}

async function makeAppImage(directory, payload, icon, metadata, tools, env, run) {
  await fs.mkdir(directory);
  const stage = path.join(directory, "stage");
  await fs.mkdir(stage);
  const configuration = {
    productName: "Vortex",
    productFilename: "Vortex",
    executableName: "vortex",
    desktopEntry: desktopEntry("AppRun %U", "vortex") + `X-AppImage-Version=${metadata.version}\n`,
    icons: [{ file: icon, size: 256 }],
    fileAssociations: [],
  };
  await writeJson(path.join(directory, "configuration.json"), configuration);
  await run(
    tools.appBuilder,
    [
      "appimage",
      "--stage",
      stage,
      "--arch",
      "x64",
      "--output",
      path.join(directory, `Vortex-${metadata.version}-x86_64.AppImage`),
      "--app",
      payload,
      "--configuration",
      JSON.stringify(configuration),
    ],
    { cwd: directory, env, log: path.join(directory, "build.log") },
  );
}

export async function packageLinux(
  options,
  { platform = process.platform, arch = process.arch, run = runCommand } = {},
) {
  if (platform !== "linux" || arch !== "x64")
    throw new Error("Linux distribution generation currently requires Linux x64");
  const input = await fs.realpath(options.input);
  const outputParent = await newPath(options.output);
  const cache = await newPath(options.cache);
  for (const directory of [outputParent, cache]) {
    if (within(input, directory) || within(directory, input))
      throw new Error("Package output/cache must be separate from its input");
  }
  await fs.mkdir(outputParent, { recursive: true });
  const output = await fs.mkdtemp(path.join(outputParent, "run-"));
  const state = {
    startedAt: new Date().toISOString(),
    input,
    formats: [],
    status: "preparing",
    packageIdentity: {
      snapName: options.snapName,
      flatpakId: options.flatpakId,
      flatpakBranch: options.flatpakBranch,
    },
  };
  const journal = path.join(output, "result.json");
  await writeJson(journal, state);
  const env = { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" };
  for (const key of [
    "NEXUS_API_KEY",
    "VORTEX_AI_NEXUS_API_KEY",
    "DOTNET_ROOT",
    "DOTNET_ROOT_X64",
    "ELECTRON_RUN_AS_NODE",
  ])
    delete env[key];
  env.TMPDIR = path.join(output, "tmp");
  await fs.mkdir(env.TMPDIR, { mode: 0o700 });
  try {
    const mainRequire = createRequire(path.join(options.root, "src/main/package.json"));
    const builderRequire = createRequire(mainRequire.resolve("electron-builder/package.json"));
    const libraryRequire = createRequire(builderRequire.resolve("app-builder-lib/package.json"));
    const binRequire = createRequire(libraryRequire.resolve("app-builder-bin/package.json"));
    if (
      builderRequire("electron-builder/package.json").version !== "24.13.3" ||
      binRequire("./package.json").version !== "4.0.0"
    )
      throw new Error("Review Linux packaging consumers before changing their pinned versions");
    const tools = {
      cli: mainRequire.resolve("electron-builder/cli.js"),
      appBuilder: binRequire("./index.js").appBuilderPath,
    };
    const configPath = path.join(options.root, "src/main/electron-builder.config.json");
    const config = JSON.parse(await fs.readFile(configPath, "utf8"));
    await libraryRequire("./out/util/config.js").validateConfig(config, { isEnabled: false });
    const deploy = await fs.realpath(options.deploy);
    const appDirectory = await fs.realpath(path.resolve(deploy, config.directories.app));
    if (!within(deploy, appDirectory))
      throw new Error("Prepared application must remain inside its deployment");
    const metadata = JSON.parse(await fs.readFile(path.join(appDirectory, "package.json"), "utf8"));
    if (metadata.name !== "Vortex" || !/^[0-9A-Za-z][0-9A-Za-z.+_~-]{0,31}$/.test(metadata.version))
      throw new Error("Prepare the Vortex deployment before Linux packaging");
    singleLine(metadata.homepage);
    singleLine(metadata.license);
    const asar = libraryRequire("@electron/asar");
    const packed = JSON.parse(
      asar.extractFile(path.join(input, "resources/app.asar"), "package.json").toString(),
    );
    if (packed.version !== metadata.version || packed.name !== metadata.name)
      throw new Error("Prepared deployment and common app.asar disagree");
    const payload = path.join(output, "payload");
    const snapshots = await copyTree(input, payload);
    const icon = path.join(options.root, "assets/linux/256x256.png");
    const image = await fs.readFile(icon);
    if (
      image.length < 24 ||
      !image.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) ||
      image.readUInt32BE(16) !== 256 ||
      image.readUInt32BE(20) !== 256
    )
      throw new Error("Linux packaging needs its named256x256 PNG");
    state.source = {
      version: metadata.version,
      appDirectory,
      preparedMetadataSha256: await hashFile(path.join(appDirectory, "package.json")),
      appAsarSha256: await hashFile(path.join(payload, "resources/app.asar")),
      inputTreeSha256: treeDigest(snapshots.original),
      commonTreeSha256: treeDigest(snapshots.snapshot),
      configSha256: await hashFile(configPath),
    };
    state.tools = {
      node: process.version,
      electronBuilder: "24.13.3",
      appBuilderSha256: await hashFile(tools.appBuilder),
      pipeline: {},
    };
    for (const file of [
      "package-linux.mjs",
      "linux-package-files.mjs",
      "linux-package-command.mjs",
      "linux-fpm.mjs",
      "linux-fpm-lock.json",
      "linux-after-remove.sh",
    ])
      state.tools.pipeline[file] = await hashFile(new URL(file, import.meta.url));
    await writeJson(path.join(output, "payload-manifest.json"), snapshots.snapshot);
    await writeJson(journal, state);
    await run(
      process.execPath,
      [
        path.join(options.root, "scripts/verify-packaged-asar.mjs"),
        "--deploy",
        path.join(options.deploy, "node_modules"),
        "--asar",
        path.join(payload, "resources/app.asar"),
      ],
      { cwd: options.root, env, log: path.join(output, "verify-asar.log") },
    );
    let nativeEnv = env;
    if (options.formats.some((format) => ["deb", "rpm", "pacman"].includes(format))) {
      const fpm = await prepareFpm({ cacheDirectory: cache, env, run });
      nativeEnv = fpm.env;
      state.fpm = {
        version: fpm.version,
        lockSha256: fpm.lockSha256,
        ruby: fpm.ruby,
        rubyGems: fpm.rubyGems,
      };
    }
    state.tools.system = {};
    const commands = new Set();
    if (options.formats.some((format) => ["deb", "rpm", "pacman"].includes(format)))
      for (const command of ["tar", "gzip", "xz", "ar"]) commands.add(command);
    if (options.formats.includes("rpm")) commands.add("rpmbuild");
    if (options.formats.includes("snap")) commands.add("snap");
    if (options.formats.includes("flatpak"))
      for (const command of ["flatpak", "flatpak-builder"]) commands.add(command);
    for (const command of commands)
      state.tools.system[command] = await toolIdentity(
        command,
        command === "snap" ? ["version"] : ["--version"],
        env,
      );
    if (options.formats.includes("tar.gz")) {
      const util = libraryRequire("builder-util");
      state.tools.sevenZip = await toolIdentity(await util.getPath7za(), ["i"], env);
      state.tools.nodeTar = libraryRequire("tar/package.json").version;
    }
    await writeJson(journal, state);
    for (const format of options.formats) {
      const directory = path.join(output, format);
      const result = { format, startedAt: new Date().toISOString(), status: "building" };
      state.formats.push(result);
      state.status = "building";
      await writeJson(journal, state);
      if (format === "flatpak")
        await makeFlatpak(directory, payload, icon, metadata, options, env, run);
      else if (format === "snap")
        await makeSnap(directory, payload, icon, metadata, options, env, run);
      else if (format === "AppImage")
        await makeAppImage(directory, payload, icon, metadata, tools, env, run);
      else {
        await fs.mkdir(directory);
        await run(
          process.execPath,
          [
            tools.cli,
            "--projectDir",
            options.deploy,
            "--config",
            configPath,
            "--prepackaged",
            payload,
            "--linux",
            format,
            "--x64",
            "--publish",
            "never",
            `--config.directories.output=${directory}`,
            ...(["deb", "rpm", "pacman"].includes(format)
              ? [
                  `--config.${format}.afterRemove=${fileURLToPath(new URL("linux-after-remove.sh", import.meta.url))}`,
                ]
              : []),
          ],
          { cwd: options.deploy, env: nativeEnv, log: path.join(directory, "build.log") },
        );
      }
      const extensions = {
        deb: ".deb",
        rpm: ".rpm",
        pacman: ".pkg.tar.xz",
        AppImage: ".AppImage",
        snap: ".snap",
        flatpak: ".flatpak",
        "tar.gz": ".tar.gz",
      };
      const files = (await fs.readdir(directory)).filter((name) =>
        name.endsWith(extensions[format]),
      );
      if (files.length !== 1)
        throw new Error(`Expected one ${format} artifact, received ${files.length}`);
      result.artifacts = [];
      for (const name of files)
        result.artifacts.push({
          file: `${format}/${name}`,
          bytes: (await fs.stat(path.join(directory, name))).size,
          sha256: await hashFile(path.join(directory, name)),
        });
      result.status = "generated";
      result.finishedAt = new Date().toISOString();
      await writeJson(journal, state);
      console.log(`Generated ${format}: ${path.join(directory, files[0])}`);
    }
    if (
      treeDigest(await readTree(input)) !== state.source.inputTreeSha256 ||
      treeDigest(await readTree(payload)) !== state.source.commonTreeSha256
    )
      throw new Error("Common package input changed during generation");
    state.status = "generated";
    state.finishedAt = new Date().toISOString();
    await writeJson(journal, state);
    return output;
  } catch (error) {
    state.status = "failed";
    state.error = error.message;
    state.finishedAt = new Date().toISOString();
    await writeJson(journal, state);
    throw new Error(`Linux packaging failed; inputs and logs retained at ${output}`, {
      cause: error,
    });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    console.log(
      `Usage: node scripts/package-linux.mjs [--formats ${FORMATS.join(",")}]\n  [--input dist/linux-unpacked] [--deploy src/main/dist] [--output dist/linux-packages]\n  [--tool-cache dist/linux-package-tools] [--snap-name vortex] [--flatpak-branch development]\n  [--flatpak-app-id com.nexusmods.vortex]\nBuilds unsigned files only; never installs, signs or publishes them. Execution requires Linux x64.`,
    );
  } else console.log(`Linux development artifacts: ${await packageLinux(options)}`);
}
