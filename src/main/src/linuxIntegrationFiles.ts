import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";

import type { LinuxDesktopContext } from "./linuxDesktopContext";

export function readIntegrationFile(file: string): string | undefined {
  try {
    if (!fs.lstatSync(file).isFile())
      throw new Error(`Refusing a non-file integration path: ${file}`);
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Callers validate ownership before replacing a destination. Never follow its link. */
export function writeIntegrationFile(file: string, contents: string | Buffer, mode = 0o644): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, contents, { flag: "wx", mode });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function shellArgument(value: string): string {
  if (value.includes("\0")) throw new Error("A launcher argument cannot contain NUL");
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function linuxLauncher(context: LinuxDesktopContext): string {
  return (
    "#!/bin/sh\nunset LD_LIBRARY_PATH LD_PRELOAD\n" +
    Object.entries(context.environment)
      .map(([name, value]) => {
        if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) throw new Error("Invalid launcher environment name");
        return `export ${name}=${shellArgument(value)}\n`;
      })
      .join("") +
    `exec ${context.command.map(shellArgument).join(" ")} "$@"\n`
  );
}

export function integrationCommand(context: LinuxDesktopContext): string[] {
  return context.ownedEntry && context.format !== "flatpak"
    ? [path.join(path.dirname(context.icon), "launch.sh")]
    : [...context.command];
}

/** Shared assets for explicit link registration and automatic startup requests. */
export function ensureIntegrationLauncher(
  context: LinuxDesktopContext,
  iconFile: string,
): string[] {
  if (!context.ownedEntry || context.format === "flatpak") return [...context.command];
  const directory = path.dirname(context.icon),
    marker = path.join(directory, "owner");
  if (fs.existsSync(directory) && !fs.lstatSync(directory).isDirectory())
    throw new Error("Refusing a non-directory integration path");
  const owner = readIntegrationFile(marker);
  if (owner === undefined && fs.existsSync(directory) && fs.readdirSync(directory).length > 0)
    throw new Error("Refusing to overwrite an unrelated integration directory");
  if (owner !== undefined && owner !== context.protocolDesktopId)
    throw new Error("The integration directory belongs to another installation");
  writeIntegrationFile(marker, context.protocolDesktopId, 0o600);
  const command = integrationCommand(context),
    launcher = command[0]!;
  readIntegrationFile(launcher);
  readIntegrationFile(context.icon);
  writeIntegrationFile(launcher, linuxLauncher(context), 0o755);
  writeIntegrationFile(context.icon, fs.readFileSync(iconFile));
  return command;
}
