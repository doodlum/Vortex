import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, test, vi } from "vitest";

import fixtures from "./__fixtures__/protocolArguments.json";

const locations = vi.hoisted(() => ({ appData: "" }));
vi.mock("electron", () => ({
  app: { name: "Vortex", getVersion: () => "1.0.0" },
  BrowserWindow: {},
}));
vi.mock("./getVortexPath", () => ({ getVortexPath: () => locations.appData }));
vi.mock("./logging", () => ({ log: vi.fn() }));

const originalProcess = process;
let root: string;
beforeEach(() => {
  vi.resetModules();
  root = mkdtempSync(path.join(os.tmpdir(), "vortex-protocol-arguments-"));
  locations.appData = root;
  mkdirSync(path.join(root, "Vortex"));
  writeFileSync(path.join(root, "Vortex/startup.json"), "{}");
});
afterEach(() => {
  vi.unstubAllGlobals();
  if (
    path.dirname(root) !== os.tmpdir() ||
    !path.basename(root).startsWith("vortex-protocol-arguments-")
  )
    throw new Error("Unexpected argv fixture cleanup target");
  rmSync(root, { recursive: true, force: true });
});

for (const fixture of fixtures.cases) {
  for (const mode of ["cold", "warm"] as const) {
    test(`${fixture.platform} ${fixture.defaultApp ? "development" : "packaged"} ${mode} ${fixture.case}`, async () => {
      vi.stubGlobal("process", {
        ...originalProcess,
        platform: fixture.platform,
        defaultApp: fixture.defaultApp,
      });
      const { parseCommandline } = await import("./cli");
      const input = [...fixture[mode]];
      const parsed = parseCommandline(input, mode === "warm");
      expect(parsed.download).toBe(fixture.expected.download);
      expect(parsed.install).toBe(fixture.expected.install);
      expect(parsed.userData).toBe(fixture.expected.userData);
      expect(parsed.startMinimized).toBe(fixture.expected.startMinimized);
      expect(input).toEqual(fixture[mode]);
    });
  }
}

test("repeated second-instance parsing does not retain an earlier request's options", async () => {
  vi.stubGlobal("process", { ...originalProcess, platform: "linux", defaultApp: false });
  const { parseCommandline } = await import("./cli");
  const first = parseCommandline(
    ["/opt/Vortex/vortex", "--download", "nxm://example/mods/1/files/2"],
    false,
  );
  expect(first.download).toBe("nxm://example/mods/1/files/2");
  const second = parseCommandline(
    ["/opt/Vortex/vortex", "--start-minimized", "--disable-gpu"],
    true,
  );
  expect(second.download).toBeUndefined();
  expect(second.install).toBeUndefined();
  expect(second.startMinimized).toBe(true);
});

test.each(["linux", "win32"])(
  "%s accepts inline URL options without consuming boolean flags",
  async (platform) => {
    vi.stubGlobal("process", { ...originalProcess, platform, defaultApp: false });
    const { parseCommandline } = await import("./cli");
    const parsed = parseCommandline(
      ["/fixture/vortex", "--download=nxm://example/mods/1/files/2", "--start-minimized"],
      true,
    );
    expect(parsed.download).toBe("nxm://example/mods/1/files/2");
    expect(parsed.startMinimized).toBe(true);
  },
);

test("a URI-shaped explicit option value does not become a Linux download request", async () => {
  vi.stubGlobal("process", { ...originalProcess, platform: "linux", defaultApp: false });
  const { parseCommandline } = await import("./cli");
  const parsed = parseCommandline(
    ["/fixture/vortex", "--user-data", "nxm://a-literal-directory"],
    false,
  );
  expect(parsed.userData).toBe("nxm://a-literal-directory");
  expect(parsed.download).toBeUndefined();
});

test("an explicit download remains authoritative when a later raw URI is present", async () => {
  vi.stubGlobal("process", { ...originalProcess, platform: "linux", defaultApp: false });
  const { parseCommandline } = await import("./cli");
  const parsed = parseCommandline(
    [
      "/fixture/vortex",
      "--download",
      "https://example.invalid/mod.zip",
      "nxm://example/mods/1/files/2",
    ],
    false,
  );
  expect(parsed.download).toBe("https://example.invalid/mod.zip");
});

test("second-instance option values follow the declared parser rather than a separate count table", async () => {
  vi.stubGlobal("process", { ...originalProcess, platform: "linux", defaultApp: false });
  const { parseCommandline } = await import("./cli");
  const parsed = parseCommandline(
    [
      "/fixture/vortex",
      "--epic-app",
      "--epic-env",
      "--start-minimized",
      "--download",
      "--disable-gpu",
      "fixture-game",
      "fixture-environment",
      "nxm://example/mods/1/files/2",
    ],
    true,
  );
  expect(parsed).toMatchObject({ epicApp: "fixture-game", epicEnv: "fixture-environment" });
  expect(parsed.download).toBe("nxm://example/mods/1/files/2");
  expect(parsed.startMinimized).toBe(true);
});

test("packaged application directories containing electron do not imply a development app path", async () => {
  vi.stubGlobal("process", { ...originalProcess, platform: "linux", defaultApp: false });
  const { parseCommandline } = await import("./cli");
  expect(
    parseCommandline(
      ["/home/fixture/electron-apps/vortex", "--download", "nxm://example/mods/1/files/2"],
      false,
    ).download,
  ).toBe("nxm://example/mods/1/files/2");
});

test("a raw URI after the option terminator remains positional", async () => {
  vi.stubGlobal("process", { ...originalProcess, platform: "linux", defaultApp: false });
  const { parseCommandline } = await import("./cli");
  expect(
    parseCommandline(["/fixture/vortex", "--", "nxm://example/mods/1/files/2"], false).download,
  ).toBeUndefined();
});

import handoffs from "./__fixtures__/protocolHandoff.json";

for (const fixture of handoffs.cases) {
  for (const mode of ["cold", "warm"] as const) {
    test(`${fixture.platform} ${fixture.defaultApp ? "development" : "packaged"} original-order ${mode} ${fixture.case}`, async () => {
      vi.stubGlobal("process", {
        ...originalProcess,
        platform: fixture.platform,
        defaultApp: fixture.defaultApp,
      });
      const { parseCommandline, parseSecondaryCommandline } = await import("./cli");
      const before = JSON.stringify(fixture);
      const parsed =
        mode === "cold"
          ? parseCommandline(fixture.cold, false)
          : parseSecondaryCommandline(fixture.warm, fixture.additionalData);
      for (const key of ["download", "install", "userData", "profile", "startMinimized"] as const) {
        expect(parsed[key]).toBe((fixture.expected as Record<string, unknown>)[key]);
      }
      expect(JSON.stringify(fixture)).toBe(before);
    });
  }
}

test("handoff uses the sender's development mode instead of the receiver's mode", async () => {
  vi.stubGlobal("process", { ...originalProcess, platform: "linux", defaultApp: true });
  const { parseSecondaryCommandline } = await import("./cli");
  expect(
    parseSecondaryCommandline(["ignored"], {
      vortexCommandline: {
        version: 1,
        defaultApp: false,
        argv: ["/opt/vortex", "nxm://example/mods/1/files/2", "--profile", "profile"],
      },
    }),
  ).toMatchObject({ download: "nxm://example/mods/1/files/2", profile: "profile" });
});

test.each([
  undefined,
  null,
  {},
  "invalid",
  { vortexCommandline: null },
  { vortexCommandline: { version: 2, defaultApp: false, argv: ["/opt/vortex"] } },
  { vortexCommandline: { version: 1, argv: ["/opt/vortex"] } },
  { vortexCommandline: { version: 1, defaultApp: false, argv: [1] } },
  { vortexCommandline: { version: 1, defaultApp: false, argv: [] } },
  { vortexCommandline: { version: 1, defaultApp: true, argv: ["/opt/vortex"] } },
])(
  "malformed or missing handoff payload falls back to grouped argv: %j",
  async (additionalData) => {
    vi.stubGlobal("process", { ...originalProcess, platform: "linux", defaultApp: false });
    const { parseSecondaryCommandline } = await import("./cli");
    expect(
      parseSecondaryCommandline(
        [
          "/opt/vortex",
          "--download",
          "--start-minimized",
          "--disable-gpu",
          "nxm://example/mods/1/files/2",
        ],
        additionalData,
      ),
    ).toMatchObject({ download: "nxm://example/mods/1/files/2", startMinimized: true });
  },
);

test("handoff payload snapshots original argv without retaining a mutable array", async () => {
  const argv = ["/opt/vortex", "--profile", "profile"];
  vi.stubGlobal("process", { ...originalProcess, argv, defaultApp: false });
  const { getCommandlinePayload } = await import("./cli");
  const payload = getCommandlinePayload();
  argv.push("later");
  expect(payload).toEqual({
    vortexCommandline: {
      version: 1,
      defaultApp: false,
      argv: ["/opt/vortex", "--profile", "profile"],
    },
  });
});

test("a download-looking positional after the terminator does not suppress an earlier raw link", async () => {
  vi.stubGlobal("process", { ...originalProcess, platform: "linux", defaultApp: false });
  const { parseCommandline } = await import("./cli");
  expect(
    parseCommandline(["/opt/vortex", "nxm://example/mods/1/files/2", "--", "--download"], false)
      .download,
  ).toBe("nxm://example/mods/1/files/2");
});

test("an inline URI-shaped option value stays literal alongside a raw link", async () => {
  vi.stubGlobal("process", { ...originalProcess, platform: "linux", defaultApp: false });
  const { parseCommandline } = await import("./cli");
  expect(
    parseCommandline(
      ["/opt/vortex", "nxm://example/mods/1/files/2", "--user-data=nxm://a-literal-directory"],
      false,
    ),
  ).toMatchObject({
    download: "nxm://example/mods/1/files/2",
    userData: "nxm://a-literal-directory",
  });
});

for (const flag of ["-d", "-i"] as const) {
  for (const explicitFirst of [true, false]) {
    for (const forwarded of [true, false]) {
      test(`attached ${flag} remains authoritative: explicitFirst=${explicitFirst} forwarded=${forwarded}`, async () => {
        vi.stubGlobal("process", { ...originalProcess, platform: "linux", defaultApp: false });
        const { parseCommandline, parseSecondaryCommandline } = await import("./cli");
        const explicit = "https://example.invalid/explicit.zip",
          raw = "nxm://example/mods/1/files/2";
        const argv = [
          "/opt/vortex",
          ...(explicitFirst ? [flag + explicit, raw] : [raw, flag + explicit]),
        ];
        const parsed = forwarded
          ? parseSecondaryCommandline(["ignored"], {
              vortexCommandline: { version: 1, defaultApp: false, argv },
            })
          : parseCommandline(argv, false);
        expect(parsed.download).toBe(flag === "-d" ? explicit : undefined);
        expect(parsed.install).toBe(flag === "-i" ? explicit : undefined);
      });
    }
  }
}

test.each(["-d", "-i"])(
  "attached %s in a grouped fallback does not consume another option's value",
  async (flag) => {
    vi.stubGlobal("process", { ...originalProcess, platform: "linux", defaultApp: false });
    const { parseSecondaryCommandline } = await import("./cli");
    const explicit = "https://example.invalid/explicit.zip";
    const parsed = parseSecondaryCommandline(
      ["/opt/vortex", flag + explicit, "--profile", "--disable-gpu", "profile"],
      undefined,
    );
    expect(parsed.profile).toBe("profile");
    expect(parsed.download).toBe(flag === "-d" ? explicit : undefined);
    expect(parsed.install).toBe(flag === "-i" ? explicit : undefined);
  },
);
