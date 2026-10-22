import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { posix as path } from "node:path";

import { app } from "electron";

import {
  desktopAcceptsUris,
  desktopArguments,
  desktopFields,
  desktopValue,
} from "./linuxDesktopFile";

export const VORTEX_DESKTOP_PREFIX = "com.nexusmods.vortex";
export type LinuxPackageFormat =
  | "development"
  | "native"
  | "flatpak"
  | "snap"
  | "appimage"
  | "archive";
export interface LinuxDesktopContext {
  format: LinuxPackageFormat;
  desktopId: string;
  protocolDesktopId: string;
  icon: string;
  command: string[];
  dataHome: string;
  configHome: string;
  dataDirs: string[];
  ownedEntry: boolean;
  installedDesktopFile?: string;
  environment: Record<string, string>;
  flatpak?: { id: string; branch: string; arch: string };
}
export interface LinuxDesktopInputs {
  executable: string;
  appPath: string;
  home: string;
  defaultApp: boolean;
  env: NodeJS.ProcessEnv;
  read: (file: string) => string | undefined;
  realpath: (file: string) => string;
  list: (directory: string) => string[];
  host: (command: string, args: string[]) => string;
}

function absolute(value: string, label: string): string {
  if (!path.isAbsolute(value) || value.includes("\0")) throw new Error(`Invalid ${label}`);
  return value;
}
function identifier(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}
function ini(contents: string): Record<string, Record<string, string>> {
  let group: Record<string, string> | undefined;
  const result: Record<string, Record<string, string>> = {};
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    if (/^\[[^\]]+\]$/.test(line)) {
      group = result[line.slice(1, -1)] ??= {};
      continue;
    }
    const index = line.indexOf("=");
    if (group && index > 0) group[line.slice(0, index)] = line.slice(index + 1);
  }
  return result;
}
function installationKey(command: string[]): string {
  return createHash("sha256").update(JSON.stringify(command)).digest("hex").slice(0, 20);
}
const hostDirectoryQuery =
  'printf "%s\\0%s\\0%s\\0%s\\0%s\\0" "$HOME" "${XDG_CONFIG_HOME:-$HOME/.config}" "${XDG_DATA_HOME:-$HOME/.local/share}" "${XDG_DATA_DIRS:-/usr/local/share:/usr/share}" "$(command -v flatpak)"';

export function resolveLinuxDesktopContext(input: LinuxDesktopInputs): LinuxDesktopContext {
  const executable = absolute(input.realpath(input.executable), "Vortex executable");
  const home = absolute(input.home, "home directory");
  const dataHome = input.env.XDG_DATA_HOME?.startsWith("/")
    ? absolute(input.env.XDG_DATA_HOME, "data home")
    : path.join(home, ".local/share");
  const configHome = input.env.XDG_CONFIG_HOME?.startsWith("/")
    ? absolute(input.env.XDG_CONFIG_HOME, "config home")
    : path.join(home, ".config");
  const dataDirs = (input.env.XDG_DATA_DIRS || "/usr/local/share:/usr/share")
    .split(":")
    .filter((value) => value.startsWith("/"));
  const base = { dataHome, configHome, dataDirs, environment: {} };
  const flatpakInfo = input.read("/.flatpak-info");
  if (flatpakInfo !== undefined) {
    const metadata = ini(flatpakInfo),
      instance = metadata.Instance ?? {};
    const id = identifier(metadata.Application?.name ?? "", "Flatpak application ID");
    const branch = identifier(instance.branch ?? "", "Flatpak branch");
    const arch = identifier(instance.arch ?? "", "Flatpak architecture");
    const appPath = absolute(instance["app-path"] ?? "", "Flatpak application path");
    if (
      instance.build === "true" ||
      instance.sandbox === "true" ||
      instance["original-app-path"] !== undefined
    )
      throw new Error("Desktop integration requires a normal installed Flatpak deployment");
    const values = input.host("/bin/sh", ["-c", hostDirectoryQuery]).split("\0");
    const [hostHome, hostConfig, hostData, hostDirs, flatpak] = values;
    absolute(hostHome ?? "", "host home");
    const hostBase = {
      dataHome: absolute(hostData ?? "", "host data home"),
      configHome: absolute(hostConfig ?? "", "host config home"),
      dataDirs: (hostDirs ?? "").split(":").filter((value) => value.startsWith("/")),
      environment: {},
    };
    const ref = `${id}/${arch}/${branch}`;
    const installations = input
      .host("flatpak", ["list", "--app", "--columns=ref,installation"])
      .trim()
      .split("\n");
    const matches: string[][] = [];
    for (const row of installations) {
      const [candidate, origin] = row.split("\t");
      if (candidate?.replace(/^app\//, "") !== ref || !origin) continue;
      const selection =
        origin === "user"
          ? "--user"
          : origin === "system"
            ? "--system"
            : `--installation=${identifier(origin, "Flatpak installation")}`;
      const location = input
        .host("flatpak", ["info", selection, "--show-location", `app/${ref}`])
        .trim();
      if (path.join(location, "files") === appPath) matches.push([selection]);
    }
    if (matches.length !== 1)
      throw new Error("Unable to identify the running Flatpak installation");
    const command = [
      absolute(flatpak ?? "", "host Flatpak executable"),
      "run",
      ...matches[0]!,
      `--branch=${branch}`,
      `--arch=${arch}`,
      id,
    ];
    const key = installationKey(command);
    return {
      ...hostBase,
      format: "flatpak",
      desktopId: `${id}.desktop`,
      protocolDesktopId: `${id}.handler.${key}.desktop`,
      icon: id,
      command,
      ownedEntry: true,
      flatpak: { id, branch, arch },
    };
  }
  const snapRoot = input.env.SNAP;
  if (snapRoot && executable.startsWith(`${snapRoot}/`)) {
    const name = identifier(input.env.SNAP_NAME ?? "", "Snap name");
    const instance = identifier(input.env.SNAP_INSTANCE_NAME ?? name, "Snap instance");
    const directory = "/var/lib/snapd/desktop/applications";
    const hinted = input.env.SNAP_APP_DESKTOP_FILE;
    const candidates = hinted
      ? [hinted]
      : input
          .list(directory)
          .filter((file) => file.startsWith(`${instance}_`) && file.endsWith(".desktop"))
          .map((file) => path.join(directory, file));
    const entries: { file: string; launcher: string }[] = [];
    for (const file of candidates) {
      if (path.dirname(file) !== directory) continue;
      const contents = input.read(file);
      if (contents === undefined) continue;
      const fields = desktopFields(contents);
      if (
        !desktopAcceptsUris(fields) ||
        fields["X-SnapInstanceName"] !== instance ||
        !fields["X-SnapAppName"]
      )
        continue;
      const appName = identifier(fields["X-SnapAppName"], "Snap application");
      const launcher = "/snap/bin/" + instance + (appName === name ? "" : "." + appName);
      if (desktopArguments(fields.Exec ?? "").includes(launcher)) entries.push({ file, launcher });
    }
    if (entries.length !== 1)
      throw new Error("Unable to identify the installed Snap desktop entry");
    const desktopId = path.basename(entries[0]!.file);
    return {
      ...base,
      format: "snap",
      desktopId,
      protocolDesktopId: desktopId,
      icon: `/snap/${instance}/current/meta/gui/icon.png`,
      command: [entries[0]!.launcher],
      installedDesktopFile: entries[0]!.file,
      ownedEntry: false,
    };
  }
  const appImage = input.env.APPIMAGE,
    appDir = input.env.APPDIR;
  if (appImage && appDir && executable.startsWith(`${appDir}/`)) {
    const command = [absolute(input.realpath(appImage), "AppImage path")],
      key = installationKey(command);
    const desktopId = `${VORTEX_DESKTOP_PREFIX}.appimage.${key}.desktop`;
    return {
      ...base,
      format: "appimage",
      desktopId,
      protocolDesktopId: desktopId,
      icon: path.join(dataHome, "vortex/integration", key, "icon.png"),
      command,
      ownedEntry: true,
    };
  }
  if (input.defaultApp) {
    const command = [executable, absolute(input.realpath(input.appPath), "development app path")],
      key = installationKey(command);
    const environment: Record<string, string> = {};
    for (const name of [
      "XDG_DATA_DIRS",
      "GIO_EXTRA_MODULES",
      "GDK_PIXBUF_MODULE_FILE",
      "CHROME_DEVEL_SANDBOX",
      "ELECTRON_OVERRIDE_DIST_PATH",
      "NODE_ENV",
    ]) {
      const value = input.env[name];
      if (value) environment[name] = value;
    }
    const desktopId = `${VORTEX_DESKTOP_PREFIX}.dev.${key}.desktop`;
    return {
      ...base,
      environment,
      format: "development",
      desktopId,
      protocolDesktopId: desktopId,
      icon: path.join(dataHome, "vortex/integration", key, "icon.png"),
      command,
      ownedEntry: true,
    };
  }
  // The native generator exports vortex.desktop. Respect XDG precedence: a user
  // entry shadowing that ID must not route this installation to another program.
  const nativeId = "vortex.desktop";
  for (const directory of [
    path.join(dataHome, "applications"),
    ...dataDirs.map((value) => path.join(value, "applications")),
  ]) {
    const contents = input.read(path.join(directory, nativeId));
    if (contents === undefined) continue;
    const fields = desktopFields(contents);
    const installedExecutable = desktopArguments(fields.Exec ?? "")[0];
    if (
      !desktopAcceptsUris(fields) ||
      !installedExecutable ||
      !path.isAbsolute(installedExecutable) ||
      input.realpath(installedExecutable) !== executable
    )
      break;
    return {
      ...base,
      format: "native",
      desktopId: nativeId,
      protocolDesktopId: nativeId,
      icon: fields.Icon ? desktopValue(fields.Icon) : "vortex",
      installedDesktopFile: path.join(directory, nativeId),
      command: [executable],
      ownedEntry: false,
    };
  }
  const command = [executable],
    key = installationKey(command),
    desktopId = `${VORTEX_DESKTOP_PREFIX}.archive.${key}.desktop`;
  return {
    ...base,
    format: "archive",
    desktopId,
    protocolDesktopId: desktopId,
    icon: path.join(dataHome, "vortex/integration", key, "icon.png"),
    command,
    ownedEntry: true,
  };
}

let current: LinuxDesktopContext | undefined;
function read(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
export function linuxHostCommand(
  command: string,
  args: string[],
  context = current,
  input?: string | Buffer,
): string {
  const flatpak = context?.format === "flatpak" || fs.existsSync("/.flatpak-info");
  const result = spawnSync(
    flatpak ? "flatpak-spawn" : command,
    flatpak ? ["--host", "--directory=/", command, ...args] : args,
    { encoding: "utf8", input, timeout: 10000, maxBuffer: 1024 * 1024 },
  );
  if (result.error || result.status !== 0)
    throw new Error(
      `Linux desktop command failed: ${command} (exit ${result.status}, signal ${result.signal ?? "none"}): ${result.error?.message ?? result.stderr.trim()}`,
    );
  return result.stdout;
}
export function initializeLinuxDesktopContext(): LinuxDesktopContext | undefined {
  if (process.platform !== "linux") return undefined;
  current = resolveLinuxDesktopContext({
    executable: process.execPath,
    appPath: app.getAppPath(),
    home: app.getPath("home"),
    defaultApp: process.defaultApp === true,
    env: process.env,
    read,
    realpath: fs.realpathSync,
    list: (directory) => fs.readdirSync(directory),
    host: (command, args) => linuxHostCommand(command, args),
  });
  app.setDesktopName(current.desktopId);
  return current;
}
export function getLinuxDesktopContext(): LinuxDesktopContext {
  if (!current) throw new Error("Linux desktop integration is unavailable");
  return current;
}
