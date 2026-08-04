import { afterEach, describe, expect, it, vi } from "vitest";

import {
  disableShaderCacheRedirect,
  enableShaderCacheRedirect,
  getSteamLaunchOptions,
  setSteamLaunchOptions,
} from "./steamShaderSettings";

class FakeWebSocket {
  public static expressions: string[] = [];
  public onerror?: () => void;
  public onmessage?: (event: { data: string }) => void;
  public onopen?: () => void;

  constructor(public readonly url: string) {
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
          data: JSON.stringify({ id: message.id, result: { result: { value: false } } }),
        }),
      0,
    );
  }
}

describe("Steam shader-cache launch integration", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeWebSocket.expressions = [];
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

  it("reads and writes per-game Steam launch options", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [{ title: "SharedJSContext", webSocketDebuggerUrl: "ws://steam" }],
      }),
    );
    vi.stubGlobal("WebSocket", FakeWebSocket);

    await getSteamLaunchOptions("22380");
    await setSteamLaunchOptions("22380", "wrapper %command%");
    expect(FakeWebSocket.expressions[0]).toContain("GetAppDetails(22380)");
    expect(FakeWebSocket.expressions[1]).toContain("SetAppLaunchOptions(22380");
    expect(FakeWebSocket.expressions[1]).toContain("wrapper %command%");
  });
});
