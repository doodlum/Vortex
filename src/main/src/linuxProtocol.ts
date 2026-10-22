import * as fs from "node:fs";
import path from "node:path";

import {
  getLinuxDesktopContext,
  linuxHostCommand,
  type LinuxDesktopContext,
} from "./linuxDesktopContext";
import {
  desktopAcceptsUris,
  desktopArguments,
  desktopCommand,
  desktopFields,
  desktopString,
} from "./linuxDesktopFile";
import {
  ensureIntegrationLauncher,
  readIntegrationFile,
  writeIntegrationFile,
} from "./linuxIntegrationFiles";

const OWNER = "X-Vortex-Integration";

export interface LinuxProtocolDependencies {
  context: LinuxDesktopContext;
  iconFile: string;
  host: (command: string, args: string[]) => string;
}

/** Main-process Linux nxm integration. Other schemes remain unsupported. */
export class LinuxProtocol {
  constructor(private readonly dependencies: LinuxProtocolDependencies) {}

  private defaultHandler(): string {
    return this.dependencies.host("xdg-mime", ["query", "default", "x-scheme-handler/nxm"]).trim();
  }

  private validateInstalledEntry(): void {
    const { context } = this.dependencies;
    if (context.ownedEntry) return;
    const candidates = [
      path.join(context.dataHome, "applications", context.protocolDesktopId),
      ...context.dataDirs.map((directory) =>
        path.join(directory, "applications", context.protocolDesktopId),
      ),
      ...(context.installedDesktopFile ? [context.installedDesktopFile] : []),
    ];
    const selected = candidates.find((file) => fs.existsSync(file));
    if (!context.installedDesktopFile || selected !== context.installedDesktopFile)
      throw new Error("The installed desktop entry is missing or shadowed by a user entry");
    const fields = desktopFields(readIntegrationFile(selected) ?? "");
    const arguments_ = desktopArguments(fields.Exec ?? "");
    let matches = arguments_.includes(context.command[0]!);
    if (context.format === "native") {
      try {
        matches =
          arguments_[0] !== undefined && fs.realpathSync(arguments_[0]) === context.command[0];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        matches = false;
      }
    }
    if (!desktopAcceptsUris(fields) || !matches)
      throw new Error("The installed desktop entry no longer launches this Vortex installation");
  }

  isDefault(): boolean {
    this.validateInstalledEntry();
    return this.defaultHandler() === this.dependencies.context.protocolDesktopId;
  }

  register(): void {
    this.validateInstalledEntry();
    const { context, host, iconFile } = this.dependencies;
    const applications = path.join(context.dataHome, "applications");
    const desktop = path.join(applications, context.protocolDesktopId);
    if (context.ownedEntry) {
      const previous = readIntegrationFile(desktop);
      if (previous !== undefined && desktopFields(previous)[OWNER] !== context.protocolDesktopId)
        throw new Error("Refusing to overwrite an unrelated desktop entry");
      const command = ensureIntegrationLauncher(context, iconFile);
      const contents =
        "[Desktop Entry]\nType=Application\nName=Vortex\nNoDisplay=true\n" +
        `Exec=${desktopCommand(command, true)}\nIcon=${desktopString(context.icon)}\n` +
        "Terminal=false\nCategories=Game;\nMimeType=x-scheme-handler/nxm;\n" +
        `StartupWMClass=${desktopString(context.desktopId.replace(/\.desktop$/, ""))}\n` +
        `${OWNER}=${context.protocolDesktopId}\n`;
      writeIntegrationFile(desktop, contents, 0o644);
      host("update-desktop-database", [applications]);
    }
    host("xdg-mime", ["default", context.protocolDesktopId, "x-scheme-handler/nxm"]);
    if (!this.isDefault())
      throw new Error("The desktop did not select Vortex as the Nexus link handler");
  }
}

export function currentLinuxProtocol(iconFile: string): LinuxProtocol {
  const context = getLinuxDesktopContext();
  return new LinuxProtocol({
    context,
    iconFile,
    host: (command, args) => linuxHostCommand(command, args, context),
  });
}
