import { useSyncExternalStore } from "react";

let revision = 0;
const listeners = new Set<() => void>();

export function notifySteamGamesChanged(): void {
  if (process.platform !== "linux") return;
  revision += 1;
  for (const listener of listeners) listener();
}

export const subscribeSteamGamesChanged = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const getSnapshot = (): number => revision;

/** Steam scans update an external snapshot, independently of Redux/profile changes. */
export function useSteamGamesRevision(): number {
  return useSyncExternalStore(subscribeSteamGamesChanged, getSnapshot);
}
