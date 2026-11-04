const path = require("path");
const { statSync } = require("node:fs");
const { fs, util } = require("@nexusmods/vortex-api");

const LOCAL_LOW = path.resolve(
  util.getVortexPath("appData"),
  "..",
  "LocalLow",
  "Daggerfall Workshop",
  "Daggerfall Unity",
);
const ENV_LOG = path.join(LOCAL_LOW, "DFTFU_Environment.log");
const NATIVE_EXEC = "DaggerfallUnity.x86_64";
const GAME_ID = "daggerfallunity";
const GAME_EXEC = "DaggerfallUnity.exe";
const CMD_PATTERN = "CommandLine | ";
const VERSION_PATTERN = "Version | ";
const DFMOD_EXT = ".dfmod";

function gameExecutable(gamePath) {
  if (process.platform !== "linux") return GAME_EXEC;
  if (gamePath !== undefined) {
    for (const executable of [GAME_EXEC, NATIVE_EXEC]) {
      try {
        if (statSync(path.join(gamePath, executable)).isFile()) return executable;
      } catch (err) {
        if (err.code !== "ENOENT") throw err;
      }
    }
  }
  throw new util.DataInvalid(
    "The selected directory does not contain a Daggerfall Unity executable.",
  );
}

function nativeEnvironmentLog() {
  const config = process.env.XDG_CONFIG_HOME;
  return path.join(
    config && path.isAbsolute(config) ? config : path.join(util.getVortexPath("home"), ".config"),
    "unity3d",
    "Daggerfall Workshop",
    "Daggerfall Unity",
    "DFTFU_Environment.log",
  );
}

function resolveGameVersion(gamePath) {
  const log = gameExecutable(gamePath) === NATIVE_EXEC ? nativeEnvironmentLog() : ENV_LOG;
  return fs.readFileAsync(log, { encoding: "utf8" }).then((data) => {
    const match = data.match(/^Version \| [0-9].[0-9].*/gm);
    return match
      ? Promise.resolve(match[0].substr(VERSION_PATTERN.length).trim())
      : Promise.reject(new util.DataInvalid("Unable to resolve game version"));
  });
}

async function findGame() {
  const logs = process.platform === "linux" ? [nativeEnvironmentLog(), ENV_LOG] : [ENV_LOG];
  for (const log of logs) {
    let data;
    try {
      data = await fs.readFileAsync(log, { encoding: "utf8" });
    } catch (err) {
      if (err.code === "ENOENT") continue;
      throw err;
    }
    const line = data.split(/\r?\n/).find((line) => line.startsWith(CMD_PATTERN));
    if (line === undefined) continue;
    const command = line.slice(CMD_PATTERN.length).trim();
    const quoted = command.match(/^"([^"]+)"/);
    const plain = command.match(/^(.*?DaggerfallUnity(?:\.exe|\.x86_64))(?=\s|$)/);
    const executable = quoted?.[1] ?? plain?.[1];
    if (executable === undefined) continue;
    const directory = path.dirname(executable);
    if (process.platform !== "linux") return directory;
    try {
      if (path.basename(executable) === gameExecutable(directory)) return directory;
    } catch (err) {
      if (!(err instanceof util.DataInvalid)) throw err;
    }
  }
  return undefined;
}

function testSupported(files, gameId) {
  const notSupported = () => Promise.resolve({ supported: false, requiredFiles: [] });
  const dfmods = files.filter((file) => path.extname(file) === DFMOD_EXT);

  // No point proceeding if we find 0 dfmods.
  if (dfmods.length < 1) return notSupported();

  const supported = dfmods.length > 0 && gameId === GAME_ID;

  return Promise.resolve({
    supported,
    requiredFiles: [],
  });
}

function install(files, destinationPath, gamePath) {
  const platform = gameExecutable(gamePath) === NATIVE_EXEC ? "linux" : "windows";
  const instructions = [];
  for (const file of files) {
    const normalized = file.replace(/\\/g, "/");
    if (normalized.endsWith("/")) continue;
    const parts = normalized
      .split("/")
      .slice(0, -1)
      .map((part) => part.toLowerCase());
    const platforms = parts.filter((part) => ["windows", "linux", "osx"].includes(part));
    if (platforms.some((part) => part !== platform)) continue;
    instructions.push({
      type: "copy",
      source: file,
      destination:
        path.posix.extname(normalized) === DFMOD_EXT
          ? path.join("Mods", path.posix.basename(normalized))
          : file,
    });
  }
  return Promise.resolve({ instructions });
}

function main(context) {
  context.registerGame({
    id: GAME_ID,
    name: "Daggerfall Unity",
    mergeMods: true,
    queryPath: findGame,
    supportedTools: [],
    queryModPath: () => path.join("DaggerfallUnity_Data", "StreamingAssets"),
    logo: "gameart.jpg",
    getGameVersion: resolveGameVersion,
    // Vortex queries this before discovery while registering games and browsing for paths.
    executable: (gamePath) =>
      gamePath === undefined
        ? process.platform === "linux"
          ? NATIVE_EXEC
          : GAME_EXEC
        : gameExecutable(gamePath),
    requiredFiles: process.platform === "linux" ? ["DaggerfallUnity_Data"] : [GAME_EXEC],
    setup: async (discovery) => {
      gameExecutable(discovery.path);
    },
  });

  // Select archive payloads for this game's executable, including Windows games on Linux.
  context.registerInstaller("dfmodmultiplatform", 15, testSupported, (files, destinationPath) =>
    install(
      files,
      destinationPath,
      context.api.getState().settings.gameMode.discovered[GAME_ID]?.path,
    ),
  );

  return true;
}

module.exports = {
  default: main,
};
