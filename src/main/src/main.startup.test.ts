import { readFileSync } from "node:fs";
import path from "node:path";
import { Script } from "node:vm";

import ts from "typescript";
import { expect, test, vi } from "vitest";

// Execute the actual entry module without starting Electron, changing cwd,
// registering real process handlers, writing logs or spawning a helper.
// Only import.meta.dirname needs the normal CJS bundler substitution.
const source = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source.replaceAll("import.meta.dirname", "__dirname"), {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    esModuleInterop: true,
  },
}).outputText;

async function executeEntry(
  platform: "win32" | "linux",
  args: Record<string, unknown>,
  lock = false,
  e2e = false,
) {
  const events: string[] = [];
  const payload = {
    argv: ["vortex", "nxm://test/opaque", "--profile", "profile"],
    defaultApp: false,
  };
  const quit = vi.fn(() => events.push("quit"));
  const requestLock = vi.fn(() => {
    events.push("lock");
    return lock;
  });
  const spawn = vi.fn(
    (
      _command: string,
      _args: string[],
      _options: { env: Record<string, string | undefined>; detached: boolean },
    ) => ({ on: vi.fn() }),
  );
  const report = vi.fn(() => Promise.resolve());
  const app = {
    getPath: (name: string) => path.join("virtual", name),
    getAppPath: () => path.join("virtual", "resources", "app.asar"),
    getVersion: () => "test",
    setPath: vi.fn(),
    quit,
    exit: vi.fn(),
    requestSingleInstanceLock: requestLock,
    disableHardwareAcceleration: vi.fn(),
    commandLine: { appendSwitch: vi.fn(), hasSwitch: () => false },
  };
  const errors: unknown[] = [];
  const application = vi.fn((_options: unknown) => events.push("application"));
  const Application = class {
    constructor(options: unknown) {
      application(options);
    }
    static shouldIgnoreError() {
      return false;
    }
  };
  const Empty = class {};
  const noop = () => undefined;
  const modules: Record<string, unknown> = {
    "temporal-polyfill/shim": { install: noop },
    "node:child_process": { spawn },
    "node:fs": { appendFileSync: noop, mkdirSync: noop },
    "node:fs/promises": { stat: () => Promise.resolve() },
    "node:path": path,
    os: { cpus: () => [{}] },
    "@vortex/shared": {
      DEBUG_PORT: 9222,
      HTTP_HEADER_SIZE: 1024,
      getErrorMessageOrDefault: String,
    },
    electron: {
      app,
      crashReporter: { start: () => events.push("crash") },
      dialog: { showErrorBox: (...values: unknown[]) => errors.push(values) },
    },
    i18next: { getFixedT: () => noop },
    "source-map-support": { install: noop },
    "winapi-bindings": {},
    "@vortex/shared/filesystem": { NativePathResolver: Empty },
    "./Application": Application,
    "./cli": {
      parseCommandline: () => {
        events.push("parse");
        return args;
      },
      getCommandlinePayload: () => payload,
    },
    "./downloading/ipc": { init: noop },
    "./downloading/manager": { DownloadManager: Empty },
    "./errorHandling": { terminateAsync: (error: unknown) => errors.push(error) },
    "./errorReporting": {
      reportCrash: () => Promise.resolve(),
      errorToReportableError: (value: unknown) => value,
      sendPendingCrashReport: noop,
      sendPendingNativeCrashReport: noop,
      sendReportFile: report,
    },
    "./filesystem/backend": { NodeFileSystemBackendImpl: Empty },
    "./filesystem/filesystem-impl": { NodeFileSystemImpl: Empty },
    "./filesystem/instance": { initFileSystem: noop },
    "./filesystem/path-resolver-registry": { PathResolverRegistryImpl: Empty },
    "./getVortexPath": { getVortexPath: () => path.join("virtual", "application") },
    "./ipcHandlers": { init: noop },
    "./linuxDesktopContext": { initializeLinuxDesktopContext: () => events.push("desktop") },
    "./logging": { log: noop },
    "./stylesheetCompiler": { init: noop },
    "./telemetry/ipcHandler": { initTelemetryIpcHandler: noop },
    "./telemetry/setup": { createMainTelemetryProvider: () => events.push("telemetry") },
    "./uploading/ipc": { init: noop },
    "./uploading/manager": { UploadManager: Empty },
  };
  const fakeProcess = {
    platform,
    env: { NODE_ENV: "development", VORTEX_E2E: e2e ? "1" : "0", Path: "" },
    execPath: path.join("virtual", "vortex"),
    argv: ["vortex"],
    pid: 1,
    chdir: noop,
    on: noop,
    removeListener: noop,
  };
  new Script(compiled, { filename: "main-startup-fixture.cjs" }).runInNewContext({
    require: (name: string) => {
      if (!(name in modules)) throw new Error(`Unexpected startup dependency: ${name}`);
      return modules[name];
    },
    exports: {},
    __dirname: "virtual",
    process: fakeProcess,
  });
  // main() is invoked by the real entry and has asynchronous report/stat paths.
  await vi.waitFor(() => {
    expect(errors).toEqual([]);
    expect(quit.mock.calls.length + application.mock.calls.length).toBe(1);
  });
  return { events, payload, requestLock, spawn, report, quit, application };
}

for (const platform of ["win32", "linux"] as const) {
  test(`${platform}: --run starts its helper even while another instance owns the lock`, async () => {
    const script = path.join("virtual", "helper with spaces.cjs");
    const result = await executeEntry(platform, { run: script });
    expect(result.spawn).toHaveBeenCalledOnce();
    const call = result.spawn.mock.calls[0];
    if (call === undefined) throw new Error("Terminal helper was not spawned");
    const [command, argv, options] = call;
    expect(command).toBe(path.join("virtual", "vortex"));
    expect(argv).toEqual([script]);
    expect(options.env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(options.detached).toBe(true);
    expect(result.requestLock).not.toHaveBeenCalled();
    expect(result.events).toEqual(["parse", "quit"]);
  });

  test(`${platform}: --report sends once without acquiring the UI lock`, async () => {
    const result = await executeEntry(platform, { report: "virtual-report.json" });
    expect(result.report).toHaveBeenCalledExactlyOnceWith("virtual-report.json");
    expect(result.requestLock).not.toHaveBeenCalled();
    expect(result.spawn).not.toHaveBeenCalled();
    expect(result.events).toEqual(["parse", "quit"]);
  });

  test(`${platform}: ordinary secondary forwards original arguments before initialization`, async () => {
    const result = await executeEntry(platform, {});
    expect(result.requestLock).toHaveBeenCalledExactlyOnceWith(result.payload);
    expect(result.spawn).not.toHaveBeenCalled();
    expect(result.report).not.toHaveBeenCalled();
    expect(result.events).toEqual(["parse", "lock", "quit"]);
  });

  test(`${platform}: primary initializes after payload-aware lock acquisition`, async () => {
    const args = { startMinimized: true };
    const result = await executeEntry(platform, args, true);
    expect(result.requestLock).toHaveBeenCalledExactlyOnceWith(result.payload);
    expect(result.application).toHaveBeenCalledExactlyOnceWith(args);
    expect(result.events).toEqual([
      "parse",
      "lock",
      "crash",
      "telemetry",
      "desktop",
      "application",
    ]);
  });

  test(`${platform}: isolated E2E startup continues to bypass the shared UI lock`, async () => {
    const result = await executeEntry(platform, {}, false, true);
    expect(result.requestLock).not.toHaveBeenCalled();
    expect(result.events).toEqual(["parse", "crash", "telemetry", "desktop", "application"]);
  });
}
