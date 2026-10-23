import * as fs from "fs/promises";
import { runInNewContext } from "node:vm";
import * as os from "os";
import * as path from "path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  enableDefaultToolRedirect,
  disableDefaultToolRedirect,
  disableShaderCacheRedirect,
  enableShaderCacheRedirect,
  getSteamLaunchOptions,
  setSteamCompatTool,
  setSteamLaunchOptions,
  ensureShaderCacheWrapper,
  ensureGameLaunchWrapper,
  configureShaderCache,
} from "./steamShaderSettings";

const SETTINGS_TARGET = { gamePath: os.tmpdir(), steamPath: os.tmpdir() };
class FakeWebSocket {
  public static expressions: string[] = [];
  public static witness: { gamePath?: string; steamPath?: string } = SETTINGS_TARGET;
  public static instances = 0;
  public onerror?: () => void;
  public onmessage?: (event: { data: string }) => void;
  public onopen?: () => void;

  constructor(public readonly url: string) {
    FakeWebSocket.instances++;
    window.setTimeout(() => this.onopen?.(), 0);
  }

  public close() {
    /* test double */
  }

  public send(payload: string) {
    const message = JSON.parse(payload) as { id: number; params: { expression: string } };
    FakeWebSocket.expressions.push(message.params.expression);
    window.setTimeout(
      () =>
        this.onmessage?.({
          data: JSON.stringify({
            id: message.id,
            result: { result: { value: message.id === 1 ? FakeWebSocket.witness : "" } },
          }),
        }),
      0,
    );
  }
}

describe("Steam shader-cache launch integration", () => {
  it.each(["timeout", "throws", "synchronous", "repeated"])(
    "cleans the native details subscription when it %s",
    async (mode) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => [{ title: "SharedJSContext", webSocketDebuggerUrl: "ws://steam" }],
        }),
      );
      const unregister = vi.fn();
      const clearRemoteTimeout = vi.fn();
      let fireTimeout: (() => void) | undefined;
      let latestCallback: ((details: unknown) => void) | undefined;
      const details = {
        strInstallFolder: SETTINGS_TARGET.gamePath,
        strLaunchOptions: "current %command%",
      };
      const register = vi.fn((_id: number, callback: (value: unknown) => void) => {
        latestCallback = callback;
        if (mode === "throws") throw new Error("subscription refused");
        if (mode === "synchronous") callback(details);
        if (mode === "repeated")
          queueMicrotask(() => {
            callback(details);
            callback({ ...details, strLaunchOptions: "stale" });
          });
        return { unregister };
      });
      class SubscriptionSocket extends FakeWebSocket {
        public override send(payload: string) {
          const message = JSON.parse(payload) as { id: number; params: { expression: string } };
          void Promise.resolve(
            runInNewContext(message.params.expression, {
              setTimeout: (callback: () => void) => {
                fireTimeout = callback;
                return 1;
              },
              clearTimeout: clearRemoteTimeout,
              SteamClient: {
                Apps: { RegisterForAppDetails: register },
                InstallFolder: {
                  GetInstallFolders: async () => [
                    { nFolderIndex: 0, strFolderPath: SETTINGS_TARGET.steamPath },
                  ],
                },
              },
            }),
          ).then(
            (value) =>
              this.onmessage?.({
                data: JSON.stringify({ id: message.id, result: { result: { value } } }),
              }),
            (error: Error) =>
              this.onmessage?.({
                data: JSON.stringify({
                  id: message.id,
                  result: { exceptionDetails: { text: error.message } },
                }),
              }),
          );
        }
      }
      vi.stubGlobal("WebSocket", SubscriptionSocket);
      const pending = getSteamLaunchOptions("22380", SETTINGS_TARGET);
      if (mode === "timeout") {
        const rejected = expect(pending).rejects.toThrow(
          "Timed out reading current Steam app details",
        );
        await vi.waitFor(() => expect(register).toHaveBeenCalledOnce());
        fireTimeout?.();
        latestCallback?.(details);
        await rejected;
        expect(unregister).toHaveBeenCalledOnce();
      } else if (mode === "throws") {
        await expect(pending).rejects.toThrow("subscription refused");
        expect(clearRemoteTimeout).toHaveBeenCalledOnce();
      } else {
        await expect(pending).resolves.toBe("current %command%");
        expect(register).toHaveBeenCalledTimes(3);
        expect(unregister).toHaveBeenCalledTimes(3);
        expect(clearRemoteTimeout).toHaveBeenCalledTimes(3);
      }
    },
  );

  it.each(["launch", "compat"])(
    "rechecks installation identity on the same socket before the %s setter",
    async (operation) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => [{ title: "SharedJSContext", webSocketDebuggerUrl: "ws://steam" }],
        }),
      );
      const setter = vi.fn(async () => true);
      let changed = true;
      let requests = 0;
      class EvaluatingIdentitySocket extends FakeWebSocket {
        public override send(payload: string) {
          const message = JSON.parse(payload) as { id: number; params: { expression: string } };
          void Promise.resolve(
            runInNewContext(message.params.expression, {
              setTimeout,
              clearTimeout,
              SteamClient: {
                // A default external library does not identify the client's root library.
                InstallFolder: {
                  GetInstallFolders: async () => [
                    {
                      nFolderIndex: 0,
                      strFolderPath: SETTINGS_TARGET.steamPath,
                      bIsDefaultFolder: false,
                    },
                    { nFolderIndex: 1, strFolderPath: "/external-default", bIsDefaultFolder: true },
                  ],
                },
                Apps: {
                  RegisterForAppDetails: (_appId: number, callback: (details: unknown) => void) => {
                    callback({
                      strInstallFolder:
                        changed && requests++ > 0
                          ? "/changed-installation"
                          : SETTINGS_TARGET.gamePath,
                      strLaunchOptions: "preserved",
                    });
                    return { unregister: vi.fn() };
                  },
                  SetAppLaunchOptions: setter,
                  SpecifyCompatTool: setter,
                },
              },
            }),
          ).then(
            (value) =>
              this.onmessage?.({
                data: JSON.stringify({ id: message.id, result: { result: { value } } }),
              }),
            (error: Error) =>
              this.onmessage?.({
                data: JSON.stringify({
                  id: message.id,
                  result: { exceptionDetails: { text: error.message } },
                }),
              }),
          );
        }
      }
      vi.stubGlobal("WebSocket", EvaluatingIdentitySocket);
      const apply = () =>
        operation === "launch"
          ? setSteamLaunchOptions("22380", "new %command%", SETTINGS_TARGET)
          : setSteamCompatTool("22380", "proton_10", SETTINGS_TARGET);
      await expect(apply()).rejects.toThrow("Steam installation changed");
      expect(setter).not.toHaveBeenCalled();
      expect(FakeWebSocket.instances).toBe(1);
      changed = false;
      await apply();
      expect(setter).toHaveBeenCalledOnce();
    },
  );
  it.each(["gamePath", "steamPath"] as const)(
    "refuses settings from another physical %s on the connected client",
    async (field) => {
      const other = await fs.mkdtemp(path.join(os.tmpdir(), "vortex-steam-identity-"));
      try {
        vi.stubGlobal(
          "fetch",
          vi.fn().mockResolvedValue({
            ok: true,
            json: async () => [{ title: "SharedJSContext", webSocketDebuggerUrl: "ws://steam" }],
          }),
        );
        vi.stubGlobal("WebSocket", FakeWebSocket);
        FakeWebSocket.witness = { ...SETTINGS_TARGET, [field]: other };
        await expect(setSteamLaunchOptions("22380", "%command%", SETTINGS_TARGET)).rejects.toThrow(
          "another installation",
        );
        expect(FakeWebSocket.expressions).toHaveLength(1);
        expect(FakeWebSocket.expressions.join(" ")).not.toContain("SetAppLaunchOptions");
      } finally {
        await fs.rm(other, { recursive: true, force: true });
      }
    },
  );

  it("refuses missing installation identity and rechecks stale profile authority before the operation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [{ title: "SharedJSContext", webSocketDebuggerUrl: "ws://steam" }],
      }),
    );
    vi.stubGlobal("WebSocket", FakeWebSocket);
    FakeWebSocket.witness = { gamePath: SETTINGS_TARGET.gamePath };
    await expect(getSteamLaunchOptions("22380", SETTINGS_TARGET)).rejects.toThrow(
      "identity is unavailable",
    );
    FakeWebSocket.witness = SETTINGS_TARGET;
    FakeWebSocket.expressions = [];
    await expect(
      setSteamCompatTool("22380", "proton_10", {
        ...SETTINGS_TARGET,
        assertCurrent: () => {
          throw new Error("profile changed");
        },
      }),
    ).rejects.toThrow("profile changed");
    expect(FakeWebSocket.expressions).toHaveLength(1);
  });

  it.runIf(process.platform === "linux")(
    "accepts physical aliases while retaining one settings connection",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "vortex-steam-alias-"));
      try {
        const alias = path.join(root, "alias");
        await fs.symlink(SETTINGS_TARGET.gamePath, alias, "dir");
        vi.stubGlobal(
          "fetch",
          vi.fn().mockResolvedValue({
            ok: true,
            json: async () => [{ title: "SharedJSContext", webSocketDebuggerUrl: "ws://steam" }],
          }),
        );
        vi.stubGlobal("WebSocket", FakeWebSocket);
        await setSteamLaunchOptions("22380", "%command%", { gamePath: alias, steamPath: alias });
        expect(FakeWebSocket.instances).toBe(1);
        expect(FakeWebSocket.expressions).toHaveLength(2);
        expect(FakeWebSocket.expressions[1]).toContain("Steam installation changed");
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
  it("reads current native app details when the library store still caches old launch options", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [{ title: "SharedJSContext", webSocketDebuggerUrl: "ws://steam" }],
      }),
    );
    let complete: (value: { strLaunchOptions: string; strInstallFolder: string }) => void;
    const details = new Promise<{ strLaunchOptions: string; strInstallFolder: string }>(
      (resolve) => {
        complete = resolve;
      },
    );
    const unregister = vi.fn();
    const cachedRequest = vi.fn(async () => ({
      strLaunchOptions: "stale",
      strInstallFolder: "/stale",
    }));
    const request = vi.fn((_appId: number, callback: (value: unknown) => void) => {
      void details.then(callback);
      return { unregister };
    });
    class EvaluatingSocket extends FakeWebSocket {
      public override send(payload: string) {
        const message = JSON.parse(payload) as { id: number; params: { expression: string } };
        void Promise.resolve(
          runInNewContext(message.params.expression, {
            setTimeout,
            clearTimeout,
            appDetailsStore: { RequestAppDetails: cachedRequest, GetAppDetails: () => null },
            SteamClient: {
              Apps: { RegisterForAppDetails: request },
              InstallFolder: {
                GetInstallFolders: async () => [
                  { nFolderIndex: 0, strFolderPath: SETTINGS_TARGET.steamPath },
                ],
              },
            },
          }),
        ).then((value) => {
          this.onmessage?.({
            data: JSON.stringify({ id: message.id, result: { result: { value } } }),
          });
        });
      }
    }
    vi.stubGlobal("WebSocket", EvaluatingSocket);
    const pending = getSteamLaunchOptions("22380", SETTINGS_TARGET);
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledExactlyOnceWith(22380, expect.any(Function)),
    );
    complete({
      strLaunchOptions: "custom-wrapper %command% --preserve",
      strInstallFolder: SETTINGS_TARGET.gamePath,
    });
    await expect(pending).resolves.toBe("custom-wrapper %command% --preserve");
    expect(cachedRequest).not.toHaveBeenCalled();
    expect(unregister).toHaveBeenCalledTimes(3);
  });
  it("replaces hardlinked managed files without changing another file", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vortex-launcher-files-"));
    try {
      const sentinel = path.join(root, "sentinel");
      await fs.writeFile(sentinel, "preserved");
      const shader = path.join(root, "vortex-shader-cache-run");
      const game = path.join(root, "vortex-game-run");
      const settings = path.join(root, "shader-cache-settings", "22380.json");
      await fs.mkdir(path.dirname(settings));
      for (const target of [shader, game, settings]) await fs.link(sentinel, target);
      await ensureShaderCacheWrapper(shader);
      await ensureGameLaunchWrapper(game);
      await configureShaderCache("22380", ["/Steam/shadercache"], shader, "/private");
      expect(await fs.readFile(sentinel, "utf8")).toBe("preserved");
      expect(await fs.readFile(shader, "utf8")).toContain("def main(arguments)");
      expect(JSON.parse(await fs.readFile(settings, "utf8"))).toEqual({
        privateRoot: "/private",
        sourceRoots: [path.join("/Steam/shadercache", "22380")],
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("changes and removes the owned loader without stacking wrappers or changing user options", () => {
    const wrapper = "/home/user/wrapper's run";
    const original = "env FLAG=1 %command% --literal";
    const first = enableDefaultToolRedirect(original, "/Game/loader's.exe", wrapper);
    const next = enableDefaultToolRedirect(first, "/Game/new.exe", wrapper);
    expect(next).not.toContain("loader");
    expect(disableDefaultToolRedirect(next, wrapper)).toBe(original);
  });

  it.each(["malformed", "closed", "error", "missing"])(
    "rejects %s Steam responses and closes its socket",
    async (mode) => {
      const closed = vi.fn();
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => [{ title: "SharedJSContext", webSocketDebuggerUrl: "ws://steam" }],
        }),
      );
      class BrokenSocket {
        public onopen?: () => void;
        public onmessage?: (event: { data: string }) => void;
        public onerror?: () => void;
        public onclose?: () => void;
        constructor() {
          window.setTimeout(() => this.onopen?.(), 0);
        }
        public close() {
          closed();
        }
        public send() {
          if (mode === "closed") this.onclose?.();
          else if (mode === "error") this.onerror?.();
          else
            this.onmessage?.({
              data:
                mode === "malformed"
                  ? "not JSON"
                  : JSON.stringify({ id: 1, error: { message: "failed" } }),
            });
        }
      }
      vi.stubGlobal("WebSocket", BrokenSocket);
      await expect(getSteamLaunchOptions("22380", SETTINGS_TARGET)).rejects.toThrow(/Steam/);
      expect(closed).toHaveBeenCalledOnce();
    },
  );
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeWebSocket.expressions = [];
    FakeWebSocket.witness = SETTINGS_TARGET;
    FakeWebSocket.instances = 0;
  });

  it("preserves script-extender launch options while adding and removing the cache wrapper", () => {
    const original = 'bash -c \'set -- "${@/FalloutNVLauncher/nvse_loader}"; "$@"\' -- %command%';
    const wrapper = "/home/user/.local/share/vortex/bin/vortex-shader-cache-run";
    const enabled = enableShaderCacheRedirect(original, "22380", wrapper);

    expect(enabled).toContain("FalloutNVLauncher/nvse_loader");
    expect(enabled).toContain(`'${wrapper}' 22380 %command%`);
    expect(enableShaderCacheRedirect(enabled, "22380", wrapper)).toBe(enabled);
    expect(disableShaderCacheRedirect(enabled, "22380", wrapper)).toBe(original);
  });

  it("nests a detected default tool inside the cache wrapper", () => {
    const cache = "'/home/user/vortex-shader-cache-run' 489830 %command%";
    const redirected = enableDefaultToolRedirect(
      cache,
      "/games/Skyrim Special Edition/skse64_loader.exe",
      "/home/user/vortex-game-run",
    );

    expect(redirected).toBe(
      "'/home/user/vortex-shader-cache-run' 489830 '/home/user/vortex-game-run' " +
        "'/games/Skyrim Special Edition/skse64_loader.exe' %command%",
    );
    expect(
      enableDefaultToolRedirect(
        redirected,
        "/games/Skyrim Special Edition/skse64_loader.exe",
        "/home/user/vortex-game-run",
      ),
    ).toBe(redirected);
  });

  it("reads and writes per-game Steam launch options", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [{ title: "SharedJSContext", webSocketDebuggerUrl: "ws://steam" }],
      }),
    );
    vi.stubGlobal("WebSocket", FakeWebSocket);

    await getSteamLaunchOptions("22380", SETTINGS_TARGET);
    await setSteamLaunchOptions("22380", "wrapper %command%", SETTINGS_TARGET);
    expect(FakeWebSocket.expressions[0]).toContain("SteamClient.Apps.RegisterForAppDetails(22380");
    expect(FakeWebSocket.expressions[3]).toContain("SetAppLaunchOptions(22380");
    expect(FakeWebSocket.expressions[3]).toContain("wrapper %command%");
  });

  it("selects an official stable Proton through Steam", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [{ title: "SharedJSContext", webSocketDebuggerUrl: "ws://steam" }],
      }),
    );
    vi.stubGlobal("WebSocket", FakeWebSocket);

    await setSteamCompatTool("489830", "proton_11", SETTINGS_TARGET);
    expect(FakeWebSocket.expressions[1]).toContain(
      'SteamClient.Apps.SpecifyCompatTool(489830, "proton_11")',
    );
  });

  it("selects an installed custom Proton through Steam", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [{ title: "SharedJSContext", webSocketDebuggerUrl: "ws://steam" }],
      }),
    );
    vi.stubGlobal("WebSocket", FakeWebSocket);

    await setSteamCompatTool("489830", "GE-Proton11-3", SETTINGS_TARGET);
    expect(FakeWebSocket.expressions[1]).toContain(
      'SteamClient.Apps.SpecifyCompatTool(489830, "GE-Proton11-3")',
    );
  });
});
