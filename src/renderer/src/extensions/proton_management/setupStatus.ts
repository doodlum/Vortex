export type ProtonSetupPhase = "idle" | "checking" | "installing" | "verifying" | "ready" | "error";

export interface IProtonSetupStatus {
  appId?: string;
  message?: string;
  phase: ProtonSetupPhase;
  progress?: number;
}

let current: IProtonSetupStatus = { phase: "idle" };
const listeners = new Set<(status: IProtonSetupStatus) => void>();

export function protonSetupStatus(): IProtonSetupStatus {
  return current;
}

export function publishProtonSetupStatus(status: IProtonSetupStatus): void {
  current = status;
  for (const listener of listeners) listener(status);
}

export function subscribeProtonSetupStatus(
  listener: (status: IProtonSetupStatus) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
