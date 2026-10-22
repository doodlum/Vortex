import { log } from "../../log";
import { isDefaultProtocolClient, setDefaultProtocolClient } from "../electron";
import type { IProtocolRegistrationOptions } from "../types";

/** Resolve the launcher and perform host integration in the main process. */
export async function registerLinuxProtocolHandler(
  options: IProtocolRegistrationOptions,
): Promise<boolean> {
  if (options.protocol !== "nxm") {
    log("warn", "Linux protocol registration supports only nxm", { protocol: options.protocol });
    return false;
  }
  if (!options.setAsDefault) return false;
  const previous = await isDefaultProtocolClient(options.protocol, options.userDataPath);
  await setDefaultProtocolClient(options.protocol, options.userDataPath);
  return !previous;
}

/** Shared Linux desktop associations remain under desktop/user control. */
export function deregisterLinuxProtocolHandler(protocol: string): void {
  if (protocol === "nxm")
    log("debug", "Linux protocol deregistration is handled externally", { protocol });
}
