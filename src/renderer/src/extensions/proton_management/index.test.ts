import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { IExtensionContext } from "@/types/IExtensionContext";

import init from "./index";

const signals = vi.hoisted(() => ({
  request: vi.fn(async () => undefined),
  observe: vi.fn(),
  hook: vi.fn(),
  steamSubscribe: vi.fn(),
  activeGame: vi.fn(),
}));

vi.mock("./orchestration", () => ({
  protonCoordinator: () => ({
    request: signals.request,
    observe: signals.observe,
    hook: signals.hook,
  }),
}));
vi.mock("@/util/linux/steamRevision", () => ({
  subscribeSteamGamesChanged: signals.steamSubscribe,
}));
vi.mock("./selection", () => ({ activeProtonGame: signals.activeGame }));
vi.mock("./views/ProtonPage", () => ({ ProtonPage: () => null }));

const originalProcess = process;

beforeEach(() => {
  vi.stubGlobal("process", { ...originalProcess, platform: "linux" });
  vi.clearAllMocks();
});
afterEach(() => vi.unstubAllGlobals());

function contextFixture() {
  const events = new Map<string, () => void>();
  const state = new Map<string, () => void>();
  const once: Array<() => void> = [];
  const context = {
    registerMainPage: vi.fn(),
    registerStartHook: vi.fn(),
    once: (callback: () => void) => {
      once.push(callback);
    },
    api: {
      getState: vi.fn(),
      events: {
        on: (event: string, callback: () => void) => {
          events.set(event, callback);
        },
      },
      onStateChange: (parts: string[], callback: () => void) => {
        state.set(parts.join("."), callback);
      },
    },
  } as unknown as IExtensionContext;
  return { context, events, state, once };
}

describe("Proton extension reconciliation wiring", () => {
  it("retries on first Steam scan even when initial registration had no active Steam game", () => {
    const f = contextFixture();
    signals.activeGame.mockReturnValue(undefined);
    init(f.context);
    expect(f.context.registerStartHook).toHaveBeenCalledWith(
      80,
      "proton-dependencies",
      signals.hook,
    );
    expect(signals.request).not.toHaveBeenCalled();
    f.once[0]();
    expect(signals.request).toHaveBeenCalledOnce();
    const notifySteam = signals.steamSubscribe.mock.calls[0][0] as () => void;
    notifySteam();
    expect(signals.request).toHaveBeenCalledTimes(2);
    f.events.get("profile-did-change")!();
    f.events.get("did-deploy")!();
    expect(signals.request).toHaveBeenCalledTimes(4);
  });

  it("observes feature/mod/discovery and primary-loader state paths", () => {
    const f = contextFixture();
    init(f.context);
    f.once[0]();
    expect([...f.state.keys()].sort()).toEqual(
      [
        "persistent.mods",
        "persistent.profiles",
        "settings.gameMode.discovered",
        "settings.interface.primaryTool",
        "settings.profiles.activeProfileId",
      ].sort(),
    );
    for (const callback of f.state.values()) callback();
    expect(signals.observe).toHaveBeenCalledTimes(5);
  });

  it("does not register automation or a Proton start hook on Windows", () => {
    vi.stubGlobal("process", { ...originalProcess, platform: "win32" });
    const f = contextFixture();
    expect(init(f.context)).toBe(true);
    expect(f.context.registerMainPage).not.toHaveBeenCalled();
    expect(f.context.registerStartHook).not.toHaveBeenCalled();
    expect(f.once).toHaveLength(0);
    expect(signals.steamSubscribe).not.toHaveBeenCalled();
  });
});
