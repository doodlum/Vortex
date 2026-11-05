import { getErrorCode, getErrorMessage } from "@vortex/shared";
import jwt from "jsonwebtoken";

import { log } from "@/logging";
import type { IExtensionApi } from "@/types/IExtensionContext";
import { ProcessCanceled } from "@/util/CustomErrors";

import { clearOAuthCredentials, setOAuthCredentials } from "../actions/account";
import { setUserInfo } from "../actions/persistent";
import { accessTokenSchema } from "../types/IJWTAccessToken";
import {
  getAccountSession,
  isCurrentAccountSession,
  oauthAccountIdentity,
  type AccountSession,
} from "./accountSession";
import { requestTokenRefresh } from "./oauth";

/**
 * The one owner of the OAuth session. The credentials live in state; this module decides when
 * the access token is refreshed, runs one refresh at a time, and signs the user out when the
 * site refuses to renew. Both nexus-api (through its token provider) and the v3 client pull
 * their bearer token from here, so neither ever refreshes on its own.
 */

interface IOAuthCredentials {
  token: string;
  refreshToken: string;
  fingerprint: string;
}

// Refresh this far ahead of `exp` so a request made at the boundary doesn't pay a 401 round trip.
const REFRESH_LEEWAY_MS = 30 * 1000;

// A dead refresh token is turned down by the token endpoint with 400 invalid_grant (RFC 6749 §5.2).
const REFUSED_OAUTH_CODES = ["invalid_grant"];

const refreshes = new WeakMap<AccountSession, Promise<string | undefined>>();

function credentialsFromState(api: IExtensionApi): IOAuthCredentials | undefined {
  return api.getState().confidential.account?.["nexus"]?.["OAuthCredentials"];
}

function expiresSoon(token: string): boolean {
  const decoded: unknown = jwt.decode(token);
  const exp =
    typeof decoded === "object" && decoded !== null && typeof decoded["exp"] === "number"
      ? (decoded["exp"] as number)
      : undefined;
  // a token we can't read is left to the site to judge
  return exp !== undefined && exp * 1000 - Date.now() <= REFRESH_LEEWAY_MS;
}

/** The site turned the session down for good: drop it and ask the user to log in again. */
export function refuseLogin(api: IExtensionApi, err: unknown): void {
  if (credentialsFromState(api) === undefined) {
    return;
  }
  api.showErrorNotification("Authentication failed, please log in again", err, {
    allowReport: false,
  });
  api.store.dispatch(clearOAuthCredentials(null));
  api.store.dispatch(setUserInfo(undefined));
  api.events.emit("did-login", err);
}

async function doRefresh(
  api: IExtensionApi,
  current: IOAuthCredentials,
  session: AccountSession,
): Promise<string | undefined> {
  let reply;
  try {
    reply = await requestTokenRefresh(current.refreshToken);
  } catch (err) {
    const latest = credentialsFromState(api);
    if (!isCurrentAccountSession(api, session)) return undefined;
    if (latest?.refreshToken !== current.refreshToken) return latest?.token;
    if (REFUSED_OAUTH_CODES.includes(getErrorCode(err) ?? "")) {
      refuseLogin(api, err);
    }
    throw err;
  }

  // A different account must not receive this refresh or provide a token to its old request.
  if (!isCurrentAccountSession(api, session)) return undefined;
  // A same-account session may have received newer credentials while this request was out.
  const latest = credentialsFromState(api);
  if (latest?.refreshToken !== current.refreshToken) {
    log("info", "OAuth session changed during a refresh, discarding the result");
    return latest?.token;
  }

  const parsed = accessTokenSchema.safeParse(jwt.decode(reply.access_token));
  api.store.dispatch(
    setOAuthCredentials(
      reply.access_token,
      reply.refresh_token,
      parsed.success ? parsed.data.fingerprint : current.fingerprint,
    ),
  );
  return reply.access_token;
}

/** One refresh at a time: everyone who needs a new token while one is on its way shares it. */
function refresh(api: IExtensionApi, current: IOAuthCredentials): Promise<string | undefined> {
  const session = getAccountSession(api);
  let pending = refreshes.get(session);
  if (pending === undefined) {
    const request = doRefresh(api, current, session).finally(() => {
      if (refreshes.get(session) === request) refreshes.delete(session);
    });
    refreshes.set(session, request);
    pending = request;
  }
  return pending;
}

/**
 * The access token to send, or undefined when not logged in through OAuth. Refreshes ahead of
 * expiry; a refresh that fails for a passing reason (offline, 5xx) hands back the current token
 * and lets the request find out, and a refused one hands back undefined once the user is signed
 * out. Pass the token a 401 came back for to force a refresh while it is still the current one;
 * a refused refresh then rejects, after signing the user out.
 */
export async function getAccessToken(
  api: IExtensionApi,
  rejectedToken?: string,
): Promise<string | undefined> {
  const current = credentialsFromState(api);
  const session = getAccountSession(api);
  if (current === undefined) {
    return undefined;
  }

  if (rejectedToken !== undefined) {
    if (rejectedToken === current.token) return refresh(api, current);
    return oauthAccountIdentity({ token: rejectedToken }) === oauthAccountIdentity(current)
      ? current.token
      : undefined;
  }

  if (!expiresSoon(current.token)) {
    return current.token;
  }
  try {
    return await refresh(api, current);
  } catch (err) {
    if (!isCurrentAccountSession(api, session)) return undefined;
    const latest = credentialsFromState(api);
    log(
      "info",
      latest === undefined
        ? "OAuth refresh refused, sending no token"
        : "OAuth refresh failed, sending the current token",
      { message: getErrorMessage(err) },
    );
    return latest?.token;
  }
}

type TokenProvider = (rejectedToken?: string) => Promise<string | undefined>;
const providers = new WeakMap<AccountSession, TokenProvider>();

/** A provider belongs to one session, while permitting that account's token refreshes. */
export function tokenProviderFor(api: IExtensionApi): TokenProvider {
  const session = getAccountSession(api);
  let provider = providers.get(session);
  if (provider === undefined) {
    const check = () => {
      if (!isCurrentAccountSession(api, session))
        throw new ProcessCanceled("Nexus account session changed");
    };
    provider = async (rejectedToken?: string) => {
      check();
      const token = await getAccessToken(api, rejectedToken);
      check();
      return token;
    };
    providers.set(session, provider);
  }
  return provider;
}
