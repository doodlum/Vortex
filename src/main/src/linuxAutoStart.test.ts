import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import { LinuxAutoStart } from "./linuxAutoStart";
import type { LinuxDesktopContext } from "./linuxDesktopContext";
import { desktopArguments, desktopCommand, desktopFields } from "./linuxDesktopFile";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});
function fixture(format: LinuxDesktopContext["format"] = "development") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vortex-login-"));
  directories.push(directory);
  const context: LinuxDesktopContext = {
    format,
    desktopId: "com.nexusmods.vortex.dev.test.desktop",
    protocolDesktopId: "com.nexusmods.vortex.dev.test.desktop",
    command: ["/tools/electron", "/checkout path/src/main"],
    icon: path.join(directory, "integration", "icon.png"),
    ownedEntry: true,
    dataHome: path.join(directory, "data"),
    configHome: path.join(directory, "config"),
    dataDirs: [],
    environment: { NODE_ENV: "development" },
  };
  if (format === "native" || format === "snap") {
    context.ownedEntry = false;
    context.command = [format === "snap" ? "/snap/bin/vortex_test" : "/opt/Vortex/vortex"];
  }
  if (format === "appimage") context.command = ["/home/test/100% Games.AppImage"];
  if (format === "archive") context.command = ["/home/test/portable/vortex"];
  if (format === "flatpak") {
    context.flatpak = { id: "com.nexusmods.vortex.Test", branch: "testing", arch: "x86_64" };
    context.desktopId = context.flatpak.id + ".desktop";
    context.command = [
      "/usr/bin/flatpak",
      "run",
      "--user",
      "--branch=testing",
      "--arch=x86_64",
      context.flatpak.id,
    ];
    context.icon = context.flatpak.id;
  }
  const file = path.join(
    context.configHome,
    "autostart",
    format === "flatpak" ? context.desktopId : "com.nexusmods.vortex.desktop",
  );
  const icon = path.join(directory, "source.png");
  fs.writeFileSync(icon, "inert icon");
  const host = vi.fn(() => `${context.flatpak?.id ?? "other"}/x86_64/testing\tuser\n`);
  const portal = vi.fn((enabled: boolean, args: string[]) => {
    if (!enabled) {
      fs.rmSync(file, { force: true });
      return Promise.resolve();
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      "[Desktop Entry]\nType=Application\nX-XDP-Autostart=" +
        context.flatpak!.id +
        "\nX-Flatpak=" +
        context.flatpak!.id +
        "\nExec=" +
        desktopCommand(["flatpak", "run", "--command=vortex", context.flatpak!.id, ...args]) +
        "\n",
    );
    return Promise.resolve();
  });
  const controller = new LinuxAutoStart({
    context,
    iconFile: icon,
    host,
    requestBackground: portal,
  });
  return { directory, context, file, host, portal, controller };
}

test.each(["development", "archive", "appimage", "snap", "native"] as const)(
  "%s automatic startup uses its durable launcher and confirmed settings",
  async (format) => {
    const { context, file, controller, portal } = fixture(format);
    expect(controller.get()).toMatchObject({ openAtLogin: false, startMinimized: false });
    await controller.set(true, ["--start-minimized"]);
    expect(controller.get()).toMatchObject({ openAtLogin: true, startMinimized: true });
    const args = desktopArguments(desktopFields(fs.readFileSync(file, "utf8")).Exec!);
    expect(args).toEqual(
      context.ownedEntry
        ? [path.join(path.dirname(context.icon), "launch.sh"), "--start-minimized"]
        : [...context.command, "--start-minimized"],
    );
    expect(portal).not.toHaveBeenCalled();
    await controller.set(true, []);
    expect(controller.get().startMinimized).toBe(false);
    await controller.set(false, []);
    expect(fs.existsSync(file)).toBe(false);
    expect(controller.get().openAtLogin).toBe(false);
  },
);
test("an unrelated startup entry is neither overwritten nor deleted", async () => {
  const { controller, file } = fixture();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const contents = "[Desktop Entry]\nType=Application\nExec=/unrelated/application\n";
  fs.writeFileSync(file, contents);
  await expect(controller.set(true, [])).rejects.toThrow("unrelated");
  await expect(controller.set(false, [])).rejects.toThrow("unrelated");
  expect(fs.readFileSync(file, "utf8")).toBe(contents);
});
test("the exact legacy Vortex entry is migrated to explicit ownership", async () => {
  const { controller, file } = fixture("native");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    '[Desktop Entry]\nType=Application\nName=Vortex\nComment=Mod manager for PC games from Nexus Mods\nExec="/opt/Vortex/vortex" "--start-minimized"\nIcon=com.nexusmods.vortex\nTerminal=false\nX-GNOME-Autostart-enabled=true\n',
  );
  expect(controller.get()).toMatchObject({ openAtLogin: true, startMinimized: true });
  await controller.set(true, []);
  expect(desktopFields(fs.readFileSync(file, "utf8"))["X-Vortex-Autostart"]).toBe("1");
  expect(controller.get().startMinimized).toBe(false);
});
test.runIf(process.platform === "linux")(
  "a startup symlink cannot overwrite or remove its target",
  async () => {
    const { controller, file, directory } = fixture();
    const target = path.join(directory, "unrelated");
    fs.writeFileSync(target, "preserved");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.symlinkSync(target, file);
    await expect(controller.set(true, [])).rejects.toThrow("non-file");
    await expect(controller.set(false, [])).rejects.toThrow("non-file");
    expect(fs.readFileSync(target, "utf8")).toBe("preserved");
  },
);
test("Flatpak uses the portal, reads back its entry, and verifies minimized arguments", async () => {
  const { controller, portal } = fixture("flatpak");
  await controller.set(true, ["--start-minimized"]);
  expect(portal).toHaveBeenCalledWith(true, ["--start-minimized"], undefined);
  expect(controller.get()).toMatchObject({ openAtLogin: true, startMinimized: true });
  await controller.set(false, []);
  expect(controller.get().openAtLogin).toBe(false);
});
test("denied portal requests preserve existing startup state", async () => {
  const { controller, portal, file } = fixture("flatpak");
  await controller.set(true, []);
  const previous = fs.readFileSync(file, "utf8");
  portal.mockRejectedValue(new Error("permission denied"));
  await expect(controller.set(false, [])).rejects.toThrow("permission denied");
  expect(fs.readFileSync(file, "utf8")).toBe(previous);
  expect(controller.get().openAtLogin).toBe(true);
});
test("multiple Flatpak origins cannot silently select the wrong installation", async () => {
  const { context, controller, portal, host, file } = fixture("flatpak");
  host.mockReturnValue(
    `${context.flatpak!.id}/x86_64/testing\tuser\n${context.flatpak!.id}/x86_64/stable\tsystem\n`,
  );
  await expect(controller.set(true, [])).rejects.toThrow("unique Flatpak application ID");
  expect(portal).not.toHaveBeenCalled();
  expect(fs.existsSync(file)).toBe(false);
});
test("a claimed portal success without the requested arguments is rejected", async () => {
  const { controller, portal } = fixture("flatpak");
  const original = portal.getMockImplementation()!;
  portal.mockImplementation((enabled) => original(enabled, []));
  await expect(controller.set(true, ["--start-minimized"])).rejects.toThrow("preserve");
  expect(controller.get()).toMatchObject({ openAtLogin: true, startMinimized: false });
});
test("queued requests remain ordered and recover from an earlier failure", async () => {
  const { controller, portal } = fixture("flatpak");
  const original = portal.getMockImplementation()!;
  let release!: () => void;
  portal.mockImplementationOnce(
    () =>
      new Promise<void>((_resolve, reject) => {
        release = () => reject(new Error("first denied"));
      }),
  );
  const first = controller.set(true, []);
  const rejected = expect(first).rejects.toThrow("first denied");
  await Promise.resolve();
  const second = controller.set(true, ["--start-minimized"]);
  expect(portal).toHaveBeenCalledTimes(1);
  release();
  await rejected;
  await second;
  expect(controller.get().startMinimized).toBe(true);
  expect(original).toBeDefined();
});
test("canceled and invalid requests do not create startup files", async () => {
  const { controller, file } = fixture();
  const abort = new AbortController();
  abort.abort(new Error("window closed"));
  await expect(controller.set(true, [], abort.signal)).rejects.toThrow("window closed");
  await expect(controller.set(true, ["bad\0argument"])).rejects.toThrow("Invalid");
  expect(fs.existsSync(file)).toBe(false);
});

test.each([
  "com.nexusmods.vortex.Test/aarch64/testing\tuser\n",
  "com.nexusmods.vortex.Test/x86_64/stable\tuser\n",
  "com.nexusmods.vortex.Test/x86_64/testing\tsystem\n",
  "com.nexusmods.vortex.Test/x86_64/testing\tother-installation\n",
])("a sole replacement Flatpak reference cannot enable startup: %s", async (reference) => {
  const { controller, host, portal } = fixture("flatpak");
  host.mockReturnValue(reference);
  await expect(controller.set(true, [])).rejects.toThrow("current unique Flatpak");
  expect(portal).not.toHaveBeenCalled();
});

test("a reference changed during portal consent cannot be confirmed", async () => {
  const { controller, portal, host } = fixture("flatpak");
  const original = portal.getMockImplementation()!;
  portal.mockImplementation(async (enabled, args) => {
    await original(enabled, args);
    host.mockReturnValue("com.nexusmods.vortex.Test/x86_64/stable\tuser\n");
  });
  await expect(controller.set(true, [])).rejects.toThrow("did not confirm");
  expect(controller.get().openAtLogin).toBe(false);
});

test.each(["/unrelated/flatpak", "/other/bin/flatpak"])(
  "portal readback rejects a different executable: %s",
  async (executable) => {
    const { controller, portal, file } = fixture("flatpak");
    const original = portal.getMockImplementation()!;
    portal.mockImplementation(async (enabled, args) => {
      await original(enabled, args);
      fs.writeFileSync(
        file,
        fs
          .readFileSync(file, "utf8")
          .replace("Exec=flatpak ", `Exec=${desktopCommand([executable])} `),
      );
    });
    await expect(controller.set(true, [])).rejects.toThrow("did not confirm");
    expect(controller.get().openAtLogin).toBe(false);
  },
);

test.each([
  "OnlyShowIn=OtherDesktop;",
  "NotShowIn=GNOME;",
  "TryExec=/missing/tool",
  "AutostartCondition=unexpected",
  "DBusActivatable=true",
  "Type=Link",
])("startup readback does not confirm an entry with unknown conditions: %s", async (condition) => {
  const { controller, file } = fixture();
  await controller.set(true, []);
  const contents = fs.readFileSync(file, "utf8");
  fs.writeFileSync(
    file,
    condition.startsWith("Type=")
      ? contents.replace("Type=Application", condition)
      : contents + condition + "\n",
  );
  expect(controller.get().openAtLogin).toBe(false);
});
