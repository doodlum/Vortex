import type Nexus from "@nexusmods/nexus-api";
import type { IPreference, IPreferenceQuery } from "@nexusmods/nexus-api";

import type { IExtensionApi } from "@/types/IExtensionContext";
import { ProcessCanceled } from "@/util/CustomErrors";

import { getAccountSession } from "./accountSession";

/** The SDK's cache is not account-scoped, including writes from requests already in flight. */
export function scopeNexusPreferences(api: IExtensionApi, client: Nexus): Nexus {
  const cache = new Map<string, Promise<Partial<IPreference>>>();
  const session = getAccountSession(api);
  let generation = 0;

  function invalidate(): void {
    generation += 1;
    cache.clear();
  }

  function synchronize(): void {
    if (getAccountSession(api) !== session)
      throw new ProcessCanceled("Nexus account session changed");
  }

  function getPreferences(query: IPreferenceQuery, useCache = true): Promise<Partial<IPreference>> {
    synchronize();
    if (!session.loggedIn) {
      return Promise.reject(new ProcessCanceled("No signed-in account for preferences"));
    }
    const startedSession = session;
    const startedGeneration = generation;
    const validate = () => {
      synchronize();
      if (session !== startedSession || generation !== startedGeneration) {
        throw new ProcessCanceled("Account preferences changed while the request was in flight");
      }
    };
    let key: string;
    try {
      key = JSON.stringify(query);
    } catch (error) {
      return Promise.reject(error);
    }
    const existing = useCache ? cache.get(key) : undefined;
    if (existing !== undefined) {
      return existing.then((value) => {
        validate();
        if (cache.get(key) !== existing) throw new ProcessCanceled("Preferences read superseded");
        return value;
      });
    }

    let pending: Promise<Partial<IPreference>>;
    pending = Promise.resolve()
      // Always bypass the SDK cache: an earlier account can refill it after clearPreferencesCache.
      .then(() => {
        validate();
        return client.getPreferences(query, false);
      })
      .then((value) => {
        validate();
        if (cache.get(key) !== pending) throw new ProcessCanceled("Preferences read superseded");
        return value;
      })
      .catch((error) => {
        if (cache.get(key) === pending) cache.delete(key);
        throw error;
      });
    cache.set(key, pending);
    return pending;
  }

  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === "getPreferences") return getPreferences;
      if (property === "clearPreferencesCache") {
        return () => {
          invalidate();
          return target.clearPreferencesCache();
        };
      }
      // Keep the receiver so SDK getUserInfo's internal this.getPreferences uses our boundary too.
      return Reflect.get(target, property, receiver);
    },
  });
}
