import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, test, vi } from "vitest";
vi.mock("electron", () => ({ app: {} }));
import { type LinuxDesktopContext } from "./linuxDesktopContext";
import { desktopArguments, desktopCommand, desktopFields, desktopValue } from "./linuxDesktopFile";
import { linuxLauncher } from "./linuxIntegrationFiles";
import { LinuxProtocol } from "./linuxProtocol";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vortex-protocol-"));
  directories.push(directory);
  const context: LinuxDesktopContext = {
    format: "development",
    desktopId: "com.nexusmods.vortex.dev.test.desktop",
    protocolDesktopId: "com.nexusmods.vortex.dev.test.desktop",
    icon: path.join(directory, "integration", "icon.png"),
    command: ["/tools/electron", "/checkout path/src/main"],
    dataHome: path.join(directory, "data"),
    configHome: path.join(directory, "config"),
    dataDirs: [],
    ownedEntry: true,
    environment: { NODE_ENV: "development" },
  };
  const icon = path.join(directory, "source.png");
  fs.writeFileSync(icon, "inert icon");
  let defaultId = "other-manager.desktop";
  const host = vi.fn((_command: string, args: string[]) => {
    if (args[0] === "query") return defaultId + "\n";
    if (args[0] === "default") defaultId = args[1]!;
    return "";
  });
  const protocol = new LinuxProtocol({ context, iconFile: icon, host });
  const desktop = path.join(context.dataHome, "applications", context.protocolDesktopId);
  return { directory, context, host, protocol, desktop };
}
test("registration writes an installation-owned launcher and confirms the default by readback", () => {
  const { context, host, protocol, desktop } = fixture();
  expect(protocol.isDefault()).toBe(false);
  protocol.register();
  expect(protocol.isDefault()).toBe(true);
  const fields = desktopFields(fs.readFileSync(desktop, "utf8"));
  expect(fields["X-Vortex-Integration"]).toBe(context.desktopId);
  expect(desktopValue(fields.Icon!)).toBe(context.icon);
  expect(desktopArguments(fields.Exec!)).toEqual([
    path.join(path.dirname(context.icon), "launch.sh"),
    "%u",
  ]);
  expect(fs.readFileSync(context.icon, "utf8")).toBe("inert icon");
  expect(host).toHaveBeenCalledWith("update-desktop-database", [path.dirname(desktop)]);
  protocol.register();
});
test("failed or ignored desktop commands cannot report success", () => {
  const { protocol, host } = fixture();
  host.mockImplementation(() => {
    throw new Error("xdg command failed");
  });
  expect(() => protocol.register()).toThrow("xdg command failed");
  host.mockImplementation(() => "other-manager.desktop");
  expect(() => protocol.register()).toThrow("did not select");
});
test("does not overwrite an unrelated user desktop entry or integration folder", () => {
  const { protocol, context, desktop } = fixture();
  fs.mkdirSync(path.dirname(desktop), { recursive: true });
  fs.writeFileSync(desktop, "[Desktop Entry]\nExec=/unrelated\n");
  expect(() => protocol.register()).toThrow("unrelated desktop");
  expect(fs.readFileSync(desktop, "utf8")).toContain("/unrelated");
  fs.rmSync(desktop);
  fs.mkdirSync(path.dirname(context.icon), { recursive: true });
  fs.writeFileSync(context.icon, "unrelated");
  expect(() => protocol.register()).toThrow("unrelated integration");
  expect(fs.readFileSync(context.icon, "utf8")).toBe("unrelated");
});
test.runIf(process.platform === "linux")(
  "refuses desktop and owned icon symlinks without writing their targets",
  () => {
    const { protocol, desktop, context, directory } = fixture();
    const target = path.join(directory, "unrelated");
    fs.writeFileSync(target, "unchanged");
    fs.mkdirSync(path.dirname(desktop), { recursive: true });
    fs.symlinkSync(target, desktop);
    expect(() => protocol.register()).toThrow("non-file");
    fs.unlinkSync(desktop);
    protocol.register();
    fs.unlinkSync(context.icon);
    fs.symlinkSync(target, context.icon);
    expect(() => protocol.register()).toThrow("non-file");
    expect(fs.readFileSync(target, "utf8")).toBe("unchanged");
  },
);
test.each(["snap", "native"] as const)(
  "installed %s entries are selected without rewriting package-owned files",
  (format) => {
    const { protocol, context, desktop, host } = fixture();
    context.format = format;
    context.command = [fs.realpathSync(process.execPath)];
    context.ownedEntry = false;
    const installed = path.join(context.dataHome, "system-applications", context.protocolDesktopId);
    fs.mkdirSync(path.dirname(installed), { recursive: true });
    fs.writeFileSync(
      installed,
      "[Desktop Entry]\nType=Application\nMimeType=x-scheme-handler/nxm;\nExec=" +
        desktopCommand(context.command, true) +
        "\n",
    );
    context.installedDesktopFile = installed;
    protocol.register();
    expect(fs.existsSync(desktop)).toBe(false);
    expect(host).not.toHaveBeenCalledWith("update-desktop-database", expect.anything());
    expect(protocol.isDefault()).toBe(true);
  },
);
test("Flatpak alias keeps the exact installation and branch without creating a host wrapper", () => {
  const { protocol, context, desktop } = fixture();
  context.format = "flatpak";
  context.command = [
    "/usr/bin/flatpak",
    "run",
    "--installation=games",
    "--branch=testing",
    "--arch=x86_64",
    "com.nexusmods.vortex",
  ];
  context.icon = "com.nexusmods.vortex";
  protocol.register();
  expect(desktopArguments(desktopFields(fs.readFileSync(desktop, "utf8")).Exec!)).toEqual([
    ...context.command,
    "%u",
  ]);
});
test.runIf(process.platform === "linux")(
  "the real shell launcher preserves literal arguments and sanitizes the browser environment",
  () => {
    const { context, directory } = fixture();
    const recorder = path.join(directory, "record.cjs"),
      output = path.join(directory, "result.json"),
      launcher = path.join(directory, "launch.sh");
    fs.writeFileSync(
      recorder,
      'require("node:fs").writeFileSync(process.argv[2], JSON.stringify({args:process.argv.slice(3), env:[process.env.NODE_ENV,process.env.LD_PRELOAD,process.env.LD_LIBRARY_PATH]}));',
    );
    const args = [
      "a 'quoted' argument",
      'dollars$ backtick` double" backslash\\',
      "100% %u",
      "new\nline",
    ];
    context.command = [process.execPath, recorder, output, ...args];
    fs.writeFileSync(launcher, linuxLauncher(context), { mode: 0o755 });
    execFileSync("/bin/sh", [launcher, "nxm://argument"], {
      env: { ...process.env, LD_PRELOAD: "", LD_LIBRARY_PATH: "browser/path" },
    });
    expect(JSON.parse(fs.readFileSync(output, "utf8"))).toEqual({
      args: [...args, "nxm://argument"],
      env: ["development", null, null],
    });
  },
);

test("an installed entry shadowed or changed after startup cannot be selected", () => {
  const { protocol, context, desktop, directory } = fixture();
  context.ownedEntry = false;
  const installed = path.join(directory, "package.desktop");
  context.installedDesktopFile = installed;
  fs.writeFileSync(
    installed,
    "[Desktop Entry]\nType=Application\nMimeType=x-scheme-handler/nxm;\nExec=" +
      context.command[0] +
      " %u\n",
  );
  fs.mkdirSync(path.dirname(desktop), { recursive: true });
  fs.writeFileSync(desktop, "[Desktop Entry]\nExec=/other\n");
  expect(() => protocol.register()).toThrow("shadowed");
  fs.unlinkSync(desktop);
  fs.writeFileSync(
    installed,
    "[Desktop Entry]\nType=Application\nMimeType=x-scheme-handler/nxm;\nExec=/other\n",
  );
  expect(() => protocol.register()).toThrow("no longer launches");
});

test.each(["Hidden=true\n", "Exec=/tools/electron\n", "Exec=/tools/electron %f\n"])(
  "refuses an installed launcher changed to a disabled or URI-incapable entry before setting the default: %s",
  (override) => {
    const { protocol, context, directory, host } = fixture();
    context.format = "snap";
    context.ownedEntry = false;
    const installed = path.join(directory, "installed.desktop");
    context.installedDesktopFile = installed;
    const base = "[Desktop Entry]\nType=Application\nMimeType=x-scheme-handler/nxm;\n";
    fs.writeFileSync(
      installed,
      base + (override.startsWith("Hidden") ? "Exec=/tools/electron %u\n" : "") + override,
    );
    expect(() => protocol.register()).toThrow("no longer launches");
    expect(host).not.toHaveBeenCalled();
  },
);
