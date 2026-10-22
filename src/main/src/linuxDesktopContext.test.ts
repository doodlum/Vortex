import { expect, test, vi } from "vitest";
vi.mock("electron", () => ({ app: {} }));
import { resolveLinuxDesktopContext, type LinuxDesktopInputs } from "./linuxDesktopContext";

function fixture(overrides: Partial<LinuxDesktopInputs> = {}) {
  const files: Record<string, string> = {};
  const input: LinuxDesktopInputs = {
    executable: "/opt/portable/vortex",
    appPath: "/opt/portable/resources/app.asar",
    home: "/home/test",
    defaultApp: false,
    env: {},
    read: (file) => files[file],
    realpath: (value) => value,
    list: () => [],
    host: () => {
      throw new Error("Unexpected host command");
    },
    ...overrides,
  };
  return { files, input };
}
test("an unintegrated packaged folder is an archive, independent of build NODE_ENV", () => {
  const { input } = fixture({
    env: {
      NODE_ENV: "development",
      IS_FLATPAK: "true",
      SNAP: "/snap/unrelated/12",
      APPIMAGE: "/unrelated.AppImage",
      APPDIR: "/unrelated",
    },
  });
  const context = resolveLinuxDesktopContext(input);
  expect(context.format).toBe("archive");
  expect(context.command).toEqual([input.executable]);
  expect(context.ownedEntry).toBe(true);
  expect(context.desktopId).toMatch(/^com\.nexusmods\.vortex\.archive\.[a-f0-9]{20}\.desktop$/);
});
test("development has a script argument, an installation-specific ID and the supported Nix environment", () => {
  const { input } = fixture({
    defaultApp: true,
    executable: "/tools/electron",
    appPath: "/checkout with space/src/main",
    env: {
      NODE_ENV: "development",
      GIO_EXTRA_MODULES: "/nix/modules",
      SECRET_OTHER: "not forwarded",
    },
  });
  const context = resolveLinuxDesktopContext(input);
  expect(context.command).toEqual(["/tools/electron", input.appPath]);
  expect(context.environment).toEqual({
    NODE_ENV: "development",
    GIO_EXTRA_MODULES: "/nix/modules",
  });
  expect(resolveLinuxDesktopContext({ ...input, appPath: "/other/checkout" }).desktopId).not.toBe(
    context.desktopId,
  );
});
test("XDG homes must be absolute, and literal spaces/percent/newlines stay in Linux paths", () => {
  const { input } = fixture({
    home: "/home/test user",
    env: { XDG_CONFIG_HOME: "relative", XDG_DATA_HOME: "relative" },
    executable: "/opt/100% games\nline/vortex",
  });
  const context = resolveLinuxDesktopContext(input);
  expect(context.dataHome).toBe("/home/test user/.local/share");
  expect(context.configHome).toBe("/home/test user/.config");
  expect(context.command).toEqual([input.executable]);
});
test("AppImage uses the durable outer file and ignores its transient mounted executable", () => {
  const { input } = fixture({
    executable: "/tmp/.mount_image/vortex",
    env: { APPIMAGE: "/home/test/My Image.AppImage", APPDIR: "/tmp/.mount_image" },
  });
  const context = resolveLinuxDesktopContext(input);
  expect(context.format).toBe("appimage");
  expect(context.command).toEqual(["/home/test/My Image.AppImage"]);
  expect(
    resolveLinuxDesktopContext({
      ...input,
      executable: "/tmp/.mount_other/vortex",
      env: { ...input.env, APPDIR: "/tmp/.mount_other" },
    }).desktopId,
  ).toBe(context.desktopId);
  expect(
    resolveLinuxDesktopContext({
      ...input,
      env: { ...input.env, APPIMAGE: "/elsewhere/My Image.AppImage" },
    }).desktopId,
  ).not.toBe(context.desktopId);
});
test("native identity uses its exported launcher and falls back to an owned archive ID when shadowed", () => {
  const { input, files } = fixture({ executable: "/opt/Vortex/vortex" });
  const native =
    "[Desktop Entry]\nType=Application\nExec=/opt/Vortex/vortex %u\nIcon=vortex\nMimeType=x-scheme-handler/nxm;\n";
  files["/usr/share/applications/vortex.desktop"] = native;
  const context = resolveLinuxDesktopContext(input);
  expect(context.format).toBe("native");
  expect(context.icon).toBe("vortex");
  expect(context.ownedEntry).toBe(false);
  files["/home/test/.local/share/applications/vortex.desktop"] = native.replaceAll(
    "/opt/Vortex/vortex",
    "/unrelated/vortex",
  );
  expect(resolveLinuxDesktopContext(input).format).toBe("archive");
});

function flatpak() {
  const { input, files } = fixture({ executable: "/app/main/vortex", env: { IS_FLATPAK: "true" } });
  files["/.flatpak-info"] =
    "[Application]\nname=com.nexusmods.vortex\n[Instance]\nbranch=linux-port\narch=x86_64\napp-path=/home/test/.local/share/flatpak/app/com.nexusmods.vortex/x86_64/linux-port/commit/files\n";
  const calls: { command: string; args: string[] }[] = [];
  input.host = (command, args) => {
    calls.push({ command, args });
    if (command === "/bin/sh")
      return "/home/test\0/home/test/.config\0/home/test/.local/share\0/usr/share:/var/lib/snapd/desktop\0/usr/bin/flatpak\0";
    if (args[0] === "list")
      return "com.nexusmods.vortex/x86_64/linux-port\tuser\ncom.nexusmods.vortex/x86_64/linux-port\tsystem\ncom.nexusmods.vortex/x86_64/stable\tuser\n";
    if (args.includes("--user"))
      return "/home/test/.local/share/flatpak/app/com.nexusmods.vortex/x86_64/linux-port/commit\n";
    return "/var/lib/flatpak/app/com.nexusmods.vortex/x86_64/linux-port/commit\n";
  };
  return { input, files, calls };
}
test("Flatpak origin uses actual app-path, explicit installation, branch and host paths", () => {
  const { input, calls } = flatpak();
  const context = resolveLinuxDesktopContext(input);
  expect(context.format).toBe("flatpak");
  expect(context.command).toEqual([
    "/usr/bin/flatpak",
    "run",
    "--user",
    "--branch=linux-port",
    "--arch=x86_64",
    "com.nexusmods.vortex",
  ]);
  expect(context.desktopId).toBe("com.nexusmods.vortex.desktop");
  expect(context.protocolDesktopId).not.toBe(context.desktopId);
  expect(context.dataHome).toBe("/home/test/.local/share");
  expect(context.configHome).toBe("/home/test/.config");
  expect(calls.filter((call) => call.args[0] === "info")).toHaveLength(2);
});
test("Flatpak system or named origin is selected only when its files match the running deployment", () => {
  for (const installation of ["system", "extra-drive"]) {
    const { input, files } = flatpak();
    files["/.flatpak-info"] = files["/.flatpak-info"]!.replace(
      "/home/test/.local/share/flatpak",
      "/install",
    );
    const host = input.host;
    input.host = (command, args) =>
      args[0] === "list"
        ? `app/com.nexusmods.vortex/x86_64/linux-port\t${installation}\n`
        : args[0] === "info"
          ? "/install/app/com.nexusmods.vortex/x86_64/linux-port/commit"
          : host(command, args);
    expect(resolveLinuxDesktopContext(input).command[2]).toBe(
      installation === "system" ? "--system" : "--installation=extra-drive",
    );
  }
});
test.each(["build=true\n", "sandbox=true\n", "original-app-path=/other/files\n"])(
  "does not claim normal host relaunch for an overridden Flatpak: %s",
  (extra) => {
    const { input, files } = flatpak();
    files["/.flatpak-info"] += extra;
    expect(() => resolveLinuxDesktopContext(input)).toThrow("normal installed");
  },
);
test("refuses ambiguous or missing Flatpak installation matches", () => {
  const { input } = flatpak(),
    host = input.host;
  input.host = (command, args) => (args[0] === "list" ? "" : host(command, args));
  expect(() => resolveLinuxDesktopContext(input)).toThrow("identify");
  input.host = (command, args) =>
    args[0] === "list"
      ? "com.nexusmods.vortex/x86_64/linux-port\tuser\ncom.nexusmods.vortex/x86_64/linux-port\tuser\n"
      : host(command, args);
  expect(() => resolveLinuxDesktopContext(input)).toThrow("identify");
});
test("old snapd finds its actual exported desktop ID and stable instance launcher", () => {
  const { input, files } = fixture({
    executable: "/snap/vortex-linux-port/x1/app/vortex",
    env: {
      SNAP: "/snap/vortex-linux-port/x1",
      SNAP_NAME: "vortex-linux-port",
      SNAP_INSTANCE_NAME: "vortex-linux-port_test",
    },
    list: () => ["vortex-linux-port_test_vortex.desktop", "other.desktop"],
  });
  files["/snap/vortex-linux-port/x1/meta/snap.yaml"] = JSON.stringify({
    apps: { "vortex-linux-port": { command: "bin/vortex" } },
  });
  files["/var/lib/snapd/desktop/applications/vortex-linux-port_test_vortex.desktop"] =
    "[Desktop Entry]\nExec=env BAMF_DESKTOP_FILE_HINT=/test /snap/bin/vortex-linux-port_test %u\nX-SnapInstanceName=vortex-linux-port_test\nX-SnapAppName=vortex-linux-port\nType=Application\nMimeType=x-scheme-handler/nxm;\n";
  const context = resolveLinuxDesktopContext(input);
  expect(context.desktopId).toBe("vortex-linux-port_test_vortex.desktop");
  expect(context.command).toEqual(["/snap/bin/vortex-linux-port_test"]);
  expect(context.icon).toBe("/snap/vortex-linux-port_test/current/meta/gui/icon.png");
  expect(context.ownedEntry).toBe(false);
  input.env.SNAP_APP_DESKTOP_FILE = "/tmp/unrelated.desktop";
  expect(() => resolveLinuxDesktopContext(input)).toThrow("installed Snap");
});

test.each(["Hidden=true\n", "Exec=/opt/Vortex/vortex\n", "Exec=/opt/Vortex/vortex %f\n"])(
  "does not use a disabled or URI-incapable native entry: %s",
  (override) => {
    const { input, files } = fixture({ executable: "/opt/Vortex/vortex" });
    const base = "[Desktop Entry]\nType=Application\nMimeType=x-scheme-handler/nxm;\n";
    files["/usr/share/applications/vortex.desktop"] = base + "Exec=/opt/Vortex/vortex %u\n";
    files["/home/test/.local/share/applications/vortex.desktop"] =
      base + (override.startsWith("Hidden") ? "Exec=/opt/Vortex/vortex %u\n" : "") + override;
    expect(resolveLinuxDesktopContext(input).format).toBe("archive");
  },
);

test.each(["--profile=%u %u", "--profile=%f %u", '"%u" %u'])(
  "native identity refuses extra active fields in the selected Exec: %s",
  (suffix) => {
    const { input, files } = fixture({ executable: "/opt/Vortex/vortex" });
    files["/usr/share/applications/vortex.desktop"] =
      "[Desktop Entry]\nType=Application\nMimeType=x-scheme-handler/nxm;\nExec=/opt/Vortex/vortex " +
      suffix +
      "\n";
    expect(resolveLinuxDesktopContext(input).format).toBe("archive");
  },
);
