import type { IOAuthCredentials } from "@nexusmods/nexus-api";
import jwt from "jsonwebtoken";

import type { IExtensionApi } from "@/types/IExtensionContext";

import { accessTokenSchema } from "../types/IJWTAccessToken";

export interface AccountSession {
  readonly loggedIn: boolean;
}

interface TrackedSession {
  session: AccountSession;
  identity?: string;
  key?: string;
  token?: string;
  initialized: boolean;
}

const sessions = new WeakMap<IExtensionApi["store"], TrackedSession>();

/** Compare account claims, never a device fingerprint. Opaque tokens are distinct identities. */
export function oauthAccountIdentity(
  credentials: Pick<IOAuthCredentials, "token"> | undefined,
): string | undefined {
  if (credentials === undefined) return undefined;
  const parsed = accessTokenSchema.safeParse(jwt.decode(credentials.token));
  return parsed.success
    ? JSON.stringify([
        "jwt",
        parsed.data.iss,
        parsed.data.application_id,
        parsed.data.sub,
        parsed.data.user.id,
      ])
    : JSON.stringify(["opaque", credentials.token]);
}

function refresh(api: IExtensionApi, tracked: TrackedSession): void {
  const account = api.getState().confidential.account?.["nexus"];
  const key: string | undefined = account?.APIKey;
  const credentials: IOAuthCredentials | undefined = account?.OAuthCredentials;
  const token = credentials?.token;
  if (tracked.initialized && tracked.key === key && tracked.token === token) return;
  const identity =
    key === undefined && credentials === undefined
      ? undefined
      : JSON.stringify([key, oauthAccountIdentity(credentials)]);
  if (identity !== tracked.identity) {
    // The public marker contains no credentials. A->B->A must produce a new marker too.
    tracked.session = Object.freeze({ loggedIn: Boolean(key) || credentials !== undefined });
    tracked.identity = identity;
  }
  tracked.key = key;
  tracked.token = token;
  tracked.initialized = true;
}

export function getAccountSession(api: IExtensionApi): AccountSession {
  let tracked = sessions.get(api.store);
  if (tracked === undefined) {
    tracked = { session: Object.freeze({ loggedIn: false }), initialized: false };
    sessions.set(api.store, tracked);
    const current = tracked;
    // Observe every credential transition, including logout/login between promise callbacks.
    api.store.subscribe(() => refresh(api, current));
  }
  refresh(api, tracked);
  return tracked.session;
}

export const isCurrentAccountSession = (api: IExtensionApi, session: AccountSession): boolean =>
  getAccountSession(api) === session;
