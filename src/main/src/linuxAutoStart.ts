import * as fs from "node:fs";
import path from "node:path";

import type { LoginItemSettings } from "electron";

import type { LinuxDesktopContext } from "./linuxDesktopContext";
import { desktopArguments, desktopCommand, desktopFields, desktopString } from "./linuxDesktopFile";
import {
  ensureIntegrationLauncher,
  integrationCommand,
  readIntegrationFile,
  writeIntegrationFile,
} from "./linuxIntegrationFiles";

const ENTRY_NAME = "com.nexusmods.vortex.desktop";
const DESCRIPTION = "Mod manager for PC games from Nexus Mods";
const MARKER = "X-Vortex-Autostart";

export interface LinuxAutoStartDependencies {
  context: LinuxDesktopContext;
  iconFile: string;
  requestBackground: (enabled: boolean, args: string[], signal?: AbortSignal) => Promise<void>;
  host: (command: string, args: string[]) => string;
}

export function autoStartEntry(context: LinuxDesktopContext, command: string[]): string {
  return (
    "[Desktop Entry]\nType=Application\nName=Vortex\n" +
    `Comment=${DESCRIPTION}\nExec=${desktopCommand(command)}\nIcon=${desktopString(context.icon)}\n` +
    "Terminal=false\nX-GNOME-Autostart-enabled=true\n" +
    `${MARKER}=1\nX-Vortex-Desktop-Id=${context.desktopId}\n`
  );
}

/** Recognize the exact previous writer, including a Vortex/Electron/AppImage command. */
function legacyEntry(fields: Record<string, string>, context: LinuxDesktopContext): boolean {
  const keys = ["Type", "Name", "Comment", "Exec", "Icon", "Terminal", "X-GNOME-Autostart-enabled"];
  if (Object.keys(fields).length !== keys.length || keys.some((key) => !(key in fields)))
    return false;
  if (
    fields.Type !== "Application" ||
    fields.Name !== "Vortex" ||
    fields.Comment !== DESCRIPTION ||
    fields.Icon !== "com.nexusmods.vortex" ||
    fields.Terminal !== "false" ||
    fields["X-GNOME-Autostart-enabled"] !== "true"
  )
    return false;
  const command = desktopArguments(fields.Exec!);
  const executable = command[0];
  return (
    executable !== undefined &&
    (executable === context.command[0] ||
      /^(?:vortex|electron)(?:\.exe)?$/i.test(path.basename(executable)) ||
      /\.AppImage$/i.test(executable))
  );
}

function ownedEntry(fields: Record<string, string>, context: LinuxDesktopContext): boolean {
  if (fields[MARKER] === "1") return true;
  const portalId = fields["X-XDP-Autostart"];
  if (portalId && portalId === context.flatpak?.id && fields["X-Flatpak"] === portalId) return true;
  // The standard app ID shares its startup filename across distribution formats.
  if (portalId === "com.nexusmods.vortex" && fields["X-Flatpak"] === portalId) return true;
  return legacyEntry(fields, context);
}

export class LinuxAutoStart {
  private pending = Promise.resolve();
  constructor(private readonly dependencies: LinuxAutoStartDependencies) {}

  private entryPath(): string {
    const { context } = this.dependencies;
    return path.join(
      context.configHome,
      "autostart",
      context.format === "flatpak" ? context.desktopId : ENTRY_NAME,
    );
  }

  private currentFlatpakReference(): boolean {
    const { context, host } = this.dependencies;
    if (!context.flatpak) return false;
    const { id, arch, branch } = context.flatpak;
    const refs = host(context.command[0]!, ["list", "--app", "--columns=ref,installation"])
      .trim()
      .split("\n")
      .map((row) => row.split("\t"))
      .filter(([ref]) => ref?.replace(/^app\//, "").startsWith(id + "/"));
    if (refs.length !== 1) return false;
    const [ref, installation] = refs[0]!;
    const selection =
      installation === "user"
        ? "--user"
        : installation === "system"
          ? "--system"
          : installation
            ? "--installation=" + installation
            : undefined;
    return (
      ref?.replace(/^app\//, "") === `${id}/${arch}/${branch}` &&
      selection !== undefined &&
      context.command[2] === selection
    );
  }

  private portalArguments(fields: Record<string, string>): string[] | undefined {
    const { context } = this.dependencies;
    if (
      !context.flatpak ||
      fields["X-XDP-Autostart"] !== context.flatpak.id ||
      fields["X-Flatpak"] !== context.flatpak.id
    )
      return undefined;
    const command = desktopArguments(fields.Exec ?? "");
    if (
      !command[0] ||
      (command[0] !== "flatpak" && command[0] !== context.command[0]) ||
      command[1] !== "run" ||
      command[2] !== "--command=vortex" ||
      command[3] !== context.flatpak.id
    )
      return undefined;
    return command.slice(4);
  }

  get(): LoginItemSettings & { startMinimized: boolean } {
    const { context } = this.dependencies;
    const contents = readIntegrationFile(this.entryPath());
    let openAtLogin = false,
      startMinimized = false;
    if (contents !== undefined) {
      const fields = desktopFields(contents);
      // Generated entries have no extra startup predicates. Do not claim that a
      // manually constrained entry will launch when its predicates are unknown.
      if (
        fields.Type === "Application" &&
        fields.Hidden !== "true" &&
        fields["X-GNOME-Autostart-enabled"] !== "false" &&
        fields.DBusActivatable !== "true" &&
        !["OnlyShowIn", "NotShowIn", "TryExec", "AutostartCondition"].some(
          (key) => fields[key] !== undefined,
        )
      ) {
        if (context.format === "flatpak") {
          openAtLogin =
            this.portalArguments(fields) !== undefined && this.currentFlatpakReference();
          startMinimized = this.portalArguments(fields)?.includes("--start-minimized") ?? false;
        } else if (
          fields["X-Vortex-Desktop-Id"] === context.desktopId ||
          legacyEntry(fields, context)
        ) {
          const command = desktopArguments(fields.Exec ?? ""),
            expected = legacyEntry(fields, context) ? context.command : integrationCommand(context);
          openAtLogin = expected.every((value, index) => command[index] === value);
          startMinimized = command.slice(expected.length).includes("--start-minimized");
        }
      }
    }
    return {
      openAtLogin,
      startMinimized: openAtLogin && startMinimized,
      executableWillLaunchAtLogin: openAtLogin,
      status: openAtLogin ? "enabled" : "not-registered",
      wasOpenedAtLogin: false,
      launchItems: [],
    };
  }

  set(enabled: boolean, args: string[], signal?: AbortSignal): Promise<void> {
    if (typeof enabled !== "boolean" || !Array.isArray(args))
      return Promise.reject(new Error("Invalid automatic startup settings"));
    const parameters = [...args];
    const request = this.pending.then(() => this.apply(enabled, parameters, signal));
    this.pending = request.catch(() => {});
    return request;
  }

  private async apply(enabled: boolean, args: string[], signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (args.some((value) => typeof value !== "string" || value.includes("\0")))
      throw new Error("Invalid automatic startup arguments");
    const { context, iconFile, requestBackground } = this.dependencies;
    const file = this.entryPath(),
      current = readIntegrationFile(file);
    if (current !== undefined && !ownedEntry(desktopFields(current), context))
      throw new Error("Automatic startup is configured by an unrelated desktop entry");
    if (context.format === "flatpak") {
      if (!context.flatpak) throw new Error("Flatpak identity is unavailable");
      if (enabled) {
        // Background's API is app-ID based, so another installed branch/origin can
        // change what its generated command starts. Do not silently change current.
        if (!this.currentFlatpakReference())
          throw new Error(
            "Automatic startup requires the current unique Flatpak application ID/reference; use a separate ID for development installations",
          );
      }
      await requestBackground(enabled, args, signal);
      if (this.get().openAtLogin !== enabled)
        throw new Error("The desktop did not confirm automatic startup");
      if (enabled) {
        const actual = this.portalArguments(desktopFields(readIntegrationFile(file) ?? ""));
        if (
          !actual ||
          actual.length !== args.length ||
          actual.some((value, index) => value !== args[index])
        )
          throw new Error("The desktop did not preserve the automatic startup arguments");
      }
      return;
    }
    if (!enabled) {
      fs.rmSync(file, { force: true });
      if (readIntegrationFile(file) !== undefined)
        throw new Error("The automatic startup entry was not removed");
      return;
    }
    const command = [...ensureIntegrationLauncher(context, iconFile), ...args];
    const contents = autoStartEntry(context, command);
    writeIntegrationFile(file, contents);
    if (readIntegrationFile(file) !== contents || !this.get().openAtLogin)
      throw new Error("The automatic startup entry could not be verified");
  }
}
