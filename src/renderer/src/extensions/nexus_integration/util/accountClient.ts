import type Nexus from "@nexusmods/nexus-api";

import type { IExtensionApi } from "@/types/IExtensionContext";
import { ProcessCanceled } from "@/util/CustomErrors";

import { scopeNexusPreferences } from "./accountPreferences";
import { getAccountSession, isCurrentAccountSession, type AccountSession } from "./accountSession";
import { tokenProviderFor } from "./oauthSession";

interface Scope {
  session: AccountSession;
  retired: Promise<never>;
}
interface Authentication {
  method: "setKey" | "setTokenProvider";
  argument: unknown;
  status: "pending" | "ready" | "failed";
  promise: Promise<unknown>;
}
interface Entry extends Scope {
  client: Nexus;
  retire: () => void;
  authentication?: Authentication;
}

const isPromiseLike = (value: unknown): value is PromiseLike<unknown> =>
  value !== null &&
  (typeof value === "object" || typeof value === "function") &&
  typeof (value as PromiseLike<unknown>).then === "function";

/** Keep SDK-owned headers, validation and caches in one account's lifetime. */
export function createAccountClient(
  api: IExtensionApi,
  create: () => Nexus,
  requests: ReadonlySet<string>,
): Nexus {
  let logger: Parameters<Nexus["setLogger"]>[0] | undefined;
  let game: { value: Parameters<Nexus["setGame"]>[0] } | undefined;

  function check(scope: Scope): void {
    if (!isCurrentAccountSession(api, scope.session))
      throw new ProcessCanceled("Nexus account session changed");
  }
  function race<T>(scope: Scope, value: PromiseLike<T>): Promise<T> {
    return Promise.race([Promise.resolve(value), scope.retired]).then(
      (result) => {
        check(scope);
        return result;
      },
      (error) => {
        check(scope);
        throw error;
      },
    );
  }
  function makeEntry(): Entry {
    const session = getAccountSession(api);
    let reject!: (error: unknown) => void;
    const retired = new Promise<never>((_resolve, no) => {
      reject = no;
    });
    void retired.catch(() => undefined);
    const scope = { session, retired };
    let unsubscribe: () => void = () => undefined;
    let ended = false;
    const retire = () => {
      if (ended) return;
      ended = true;
      unsubscribe();
      reject(new ProcessCanceled("Nexus account session changed"));
    };
    const networkMethods = new Set([
      "request",
      "requestGraph",
      "requestGraphWithErrors",
      "mutateGraph",
    ]);
    const guarded = new Proxy(create(), {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        // Feedback uploads serialize mBaseData directly after their last await.
        // Limit the data guard to outbound headers; late HTTP callbacks still own their quota state.
        if (property === "mBaseData" && value !== null && typeof value === "object") {
          return new Proxy(value, {
            get(data, field, dataReceiver) {
              if (field === "headers") check(scope);
              return Reflect.get(data, field, dataReceiver);
            },
          });
        }
        if (property === "checkFileSize" && typeof value === "function") {
          return (...args: unknown[]) => {
            check(scope);
            const inspection = Promise.resolve(Reflect.apply(value, receiver, args));
            // The pinned SDK chains its form/attachment allocation directly to this .then.
            // Check in that continuation, before it can allocate a paused file stream.
            return new Proxy(inspection, {
              get(promise, field) {
                if (field === "then") {
                  return (
                    fulfilled?: (result: unknown) => unknown,
                    rejected?: (error: unknown) => unknown,
                  ) =>
                    promise.then((result) => {
                      check(scope);
                      return fulfilled ? fulfilled(result) : result;
                    }, rejected);
                }
                const member = Reflect.get(promise, field, promise);
                return typeof member === "function" ? member.bind(promise) : member;
              },
            });
          };
        }
        if (typeof value !== "function" || !networkMethods.has(String(property))) return value;
        return (...args: unknown[]) => {
          check(scope);
          // SDK request() awaits its token after this entry check. Guard the final
          // argument reads inside restGet/restPost as well, immediately before HTTP creation.
          if (property === "request" && args[1] !== null && typeof args[1] === "object") {
            args[1] = new Proxy(args[1], {
              get(data, field, dataReceiver) {
                check(scope);
                return Reflect.get(data, field, dataReceiver);
              },
            });
          }
          const result = Reflect.apply(value, receiver, args);
          return isPromiseLike(result) ? race(scope, result) : result;
        };
      },
    });
    // SDK transport callbacks may finish bookkeeping on their retired instance.
    // Public callers are cancelled by the facade; only outbound boundaries reject old work.
    const client = scopeNexusPreferences(api, guarded);
    if (logger !== undefined) client.setLogger(logger);
    if (game !== undefined) client.setGame(game.value);
    unsubscribe = api.store.subscribe(() => {
      if (!isCurrentAccountSession(api, session)) retire();
    });
    return { ...scope, client, retire };
  }

  let entry = makeEntry();
  // An empty prototype anchor must not retain the first retired SDK as the Proxy target.
  const anchor = Object.create(Object.getPrototypeOf(entry.client)) as Nexus;
  function current(): Entry {
    if (!isCurrentAccountSession(api, entry.session)) {
      entry.retire();
      entry = makeEntry();
    }
    return entry;
  }
  function authenticate(
    selected: Entry,
    method: Authentication["method"],
    args: unknown[],
  ): Promise<unknown> {
    check(selected);
    const existing = selected.authentication;
    if (
      existing?.status === "pending" &&
      existing.method === method &&
      existing.argument === args[0]
    )
      return existing.promise;
    let authentication: Authentication;
    const result = Reflect.apply(Reflect.get(selected.client, method), selected.client, args);
    const promise = Promise.resolve(result).then(
      (value) => {
        authentication.status = "ready";
        return value;
      },
      (error) => {
        authentication.status = "failed";
        throw error;
      },
    );
    authentication = { method, argument: args[0], status: "pending", promise };
    selected.authentication = authentication;
    void promise.catch(() => undefined);
    return promise;
  }
  function ready(selected: Entry): Promise<unknown> {
    check(selected);
    if (selected.authentication !== undefined) return selected.authentication.promise;
    const account = api.getState().confidential.account?.["nexus"];
    if (account?.OAuthCredentials !== undefined)
      return authenticate(selected, "setTokenProvider", [tokenProviderFor(api)]);
    if (account?.APIKey) return authenticate(selected, "setKey", [account.APIKey]);
    return Promise.resolve(undefined);
  }

  return new Proxy(anchor, {
    get(_target, property) {
      const selected = current();
      const value = Reflect.get(selected.client, property, selected.client);
      if (typeof value !== "function" || property === "constructor") return value;
      // Resolve again when invoked: callers can retain a method across an account change.
      return (...args: unknown[]) => {
        const active = current();
        if (property === "setLogger") logger = args[0] as Parameters<Nexus["setLogger"]>[0];
        if (property === "setGame") game = { value: args[0] as Parameters<Nexus["setGame"]>[0] };
        if (property === "setKey" || property === "setTokenProvider")
          return authenticate(active, property, args);
        const invoke = () => {
          check(active);
          return Reflect.apply(
            Reflect.get(active.client, property, active.client),
            active.client,
            args,
          );
        };
        if (typeof property === "string" && requests.has(property))
          return race(active, ready(active).then(invoke));
        return invoke();
      };
    },
  });
}
