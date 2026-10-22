import { expect, test } from "vitest";

import {
  desktopAcceptsUris,
  desktopArgument,
  desktopArguments,
  desktopCommand,
  desktopFields,
  desktopString,
  desktopValue,
} from "./linuxDesktopFile";

test.each([
  "plain",
  "",
  "100%",
  "space here",
  " leading and trailing ",
  "a\nb\rc\td",
  'quotes"and`dollars$and\\slashes',
  "100% %u %f %%",
  "caf\u00e9",
  "';>&|*?()~#",
])("round-trips a literal desktop argument: %j", (value) => {
  expect(desktopArguments(desktopCommand(["/bin/recorder", value]))).toEqual([
    "/bin/recorder",
    value,
  ]);
  expect(desktopValue(desktopString(value))).toBe(value);
});
test("only the explicit URI placeholder is a field code", () => {
  expect(desktopCommand(["/bin/100% tool", "%u"], true)).toBe('"/bin/100%%\\stool" %%u %u');
  expect(desktopArguments(desktopCommand(["/bin/tool", "%u"], true))).toEqual([
    "/bin/tool",
    "%u",
    "%u",
  ]);
});
test("quotes only arguments holding reserved characters", () => {
  // xdg-mime's generic default lookup resolves Exec's first word without unquoting it
  expect(desktopCommand(["/home/user/.local/share/vortex/launch.sh"], true)).toBe(
    "/home/user/.local/share/vortex/launch.sh %u",
  );
  expect(desktopCommand(["/opt/My Vortex/vortex", "--x=1"])).toBe(
    '"/opt/My\\sVortex/vortex" --x=1',
  );
  expect(desktopArgument("")).toBe('""');
});
test("reads only the main desktop group and rejects ambiguous duplicate executable fields", () => {
  expect(
    desktopFields(
      "# comment\n[Desktop Entry]\nType=Application\nName=Vortex\nName[de]=Andere\nExec=/opt/vortex %u\n[Desktop Action Open]\nExec=/wrong\n",
    ),
  ).toEqual({ Type: "Application", Name: "Vortex", Exec: "/opt/vortex %u" });
  expect(() => desktopFields("[Desktop Entry]\nExec=/one\nExec=/two")).toThrow(
    "Duplicate desktop field",
  );
});
test("rejects invalid executable/escape input instead of silently changing it", () => {
  expect(() => desktopArgument("with\0nul")).toThrow("NUL");
  expect(() => desktopCommand([])).toThrow("executable");
  expect(() => desktopArguments('"unterminated')).toThrow("Unclosed");
  expect(() => desktopArguments('"bad\\\\q"')).toThrow("Invalid");
});

test.each(["%u", "%U"])(
  "accepts an enabled URI desktop entry while preserving NoDisplay: %s",
  (code) => {
    expect(
      desktopAcceptsUris({
        Type: "Application",
        NoDisplay: "true",
        MimeType: "x-scheme-handler/nxm;",
        Exec: "/bin/recorder " + code,
      }),
    ).toBe(true);
  },
);
test.each(["", "%f", "%F", "%%u", '"%u"', '" %u "', "%u %U", "%f %u"])(
  "rejects a missing or invalid URI field code: %j",
  (code) => {
    expect(
      desktopAcceptsUris({
        Type: "Application",
        MimeType: "x-scheme-handler/nxm;",
        Exec: "/bin/recorder " + code,
      }),
    ).toBe(false);
  },
);

test.each(["--profile=%u %u", "--profile=%f %u", '"%u" %u', "--profile=%F %U", "--bad=%Q %u"])(
  "rejects an additional active macro anywhere in Exec: %s",
  (suffix) => {
    expect(
      desktopAcceptsUris({
        Type: "Application",
        MimeType: "x-scheme-handler/nxm;",
        Exec: "/bin/recorder " + suffix,
      }),
    ).toBe(false);
  },
);
test("literal escaped macros are not extra active fields", () => {
  expect(
    desktopAcceptsUris({
      Type: "Application",
      MimeType: "x-scheme-handler/nxm;",
      Exec: '/bin/recorder --literal=%%u "%%f" %u',
    }),
  ).toBe(true);
});
