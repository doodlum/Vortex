import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { quit: vi.fn() }, BrowserWindow: { getAllWindows: () => [] } }));
vi.mock("./logging", () => ({ log: vi.fn() }));

import { handleShutdownSignals, SHUTDOWN_SIGNALS } from "./linuxShutdownSignals";

function fixture(windowCount: number) {
  const listeners = new Map<string, () => void>();
  const windows = Array.from({ length: windowCount }, () => ({ close: vi.fn() }));
  const quit = vi.fn();
  handleShutdownSignals({
    on: (signal, listener) => listeners.set(signal, listener),
    windows: () => windows,
    quit,
  });
  return { listeners, windows, quit };
}

describe("handleShutdownSignals", () => {
  it("listens for logout, closed-terminal and Ctrl+C signals", () => {
    expect([...fixture(1).listeners.keys()]).toEqual([...SHUTDOWN_SIGNALS]);
  });

  it("closes every window so the normal clean shutdown runs, once", () => {
    const f = fixture(2);
    f.listeners.get("SIGTERM")!();
    f.listeners.get("SIGHUP")!();
    f.listeners.get("SIGTERM")!();
    for (const window of f.windows) expect(window.close).toHaveBeenCalledOnce();
    expect(f.quit).not.toHaveBeenCalled();
  });

  it("quits directly when no window is open", () => {
    const f = fixture(0);
    f.listeners.get("SIGINT")!();
    expect(f.quit).toHaveBeenCalledOnce();
  });
});
