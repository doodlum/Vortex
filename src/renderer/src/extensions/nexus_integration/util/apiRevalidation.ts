import type Nexus from "@nexusmods/nexus-api";

import type { IExtensionApi } from "@/types/IExtensionContext";
import { ProcessCanceled } from "@/util/CustomErrors";

import { REVALIDATION_FREQUENCY } from "../constants";
import { ensureFreshMembership } from "../membership";
import { getAccountSession, isCurrentAccountSession, type AccountSession } from "./accountSession";

/** One validation clock per account lifetime, including direct account replacement. */
export function createApiRevalidation(api: IExtensionApi) {
  let session: AccountSession = getAccountSession(api);
  let lastValidation = Date.now();
  return function invoke<T>(client: Nexus, request: () => T): T | Promise<T> {
    const selected = getAccountSession(api);
    const changed = selected !== session;
    if (changed) {
      session = selected;
      lastValidation = -Infinity;
    }
    const check = () => {
      if (!isCurrentAccountSession(api, selected))
        throw new ProcessCanceled("Nexus account session changed");
    };
    const run = () => {
      check();
      return request();
    };
    const key = api.getState().confidential.account?.["nexus"]?.APIKey;
    if (key === undefined) {
      void ensureFreshMembership(api, client);
      return run();
    }
    const now = Date.now();
    if (now <= lastValidation + REVALIDATION_FREQUENCY) return run();
    lastValidation = now;
    // A replacement must prime its current key even if the old SDK had validation data.
    const validation =
      changed || !client.getValidationResult() ? client.setKey(key) : client.revalidate();
    return Promise.resolve(validation).then((userInfo) => {
      check();
      if (userInfo) api.events.emit("did-login", null);
      // Event listeners can replace the account synchronously.
      return run();
    });
  };
}
