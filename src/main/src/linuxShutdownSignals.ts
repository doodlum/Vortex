import { app, BrowserWindow } from "electron";

import { log } from "./logging";

/** Signals that ask a Linux desktop app to quit: logout or `kill` (SIGTERM), a closed terminal (SIGHUP) and Ctrl+C (SIGINT). */
export const SHUTDOWN_SIGNALS = ["SIGTERM", "SIGHUP", "SIGINT"] as const;

export interface IShutdownSignalPorts {
  on: (signal: (typeof SHUTDOWN_SIGNALS)[number], listener: () => void) => void;
  windows: () => Array<{ close: () => void }>;
  quit: () => void;
}

const defaultPorts: IShutdownSignalPorts = {
  on: (signal, listener) => process.on(signal, listener),
  windows: () => BrowserWindow.getAllWindows(),
  quit: () => app.quit(),
};

/**
 * Electron's own handling of these signals ends the app without Vortex's shutdown, so pending
 * state writes, DuckDB and the log are not finished. Close the windows instead, as relaunch()
 * does: window-all-closed then runs the normal clean shutdown and quits. Repeated signals while
 * it runs are ignored.
 */
export function handleShutdownSignals(ports: IShutdownSignalPorts = defaultPorts): void {
  let closing = false;
  for (const signal of SHUTDOWN_SIGNALS) {
    ports.on(signal, () => {
      if (closing) return;
      closing = true;
      log("info", "closing Vortex on request", { signal });
      const windows = ports.windows();
      if (windows.length === 0) ports.quit();
      for (const window of windows) window.close();
    });
  }
}
