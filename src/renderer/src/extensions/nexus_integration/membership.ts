/** Account-scoped membership freshness. UI triggers in one session share one request. */
import type Nexus from "@nexusmods/nexus-api";

import type { IExtensionApi } from "../../types/IExtensionContext";
import Debouncer from "../../util/Debouncer";
import { REVALIDATION_FREQUENCY } from "./constants";
import { isLoggedIn, userInfo } from "./selectors";
import type { UserInfoRead } from "./util";
import { getUserInfo } from "./util";
import {
  getAccountSession,
  isCurrentAccountSession,
  type AccountSession,
} from "./util/accountSession";

const REFRESH_DEBOUNCE = 3000;
const FAILURE_COOLDOWN = 30 * 1000;
export const HOVER_REFRESH_FLOOR = REVALIDATION_FREQUENCY;

interface Freshness {
  lastRead: number;
  lastReadCooldown: number;
  inFlight?: Promise<boolean>;
}
let freshness = new WeakMap<AccountSession, Freshness>();
let debounceSession: AccountSession | undefined;

function stateFor(api: IExtensionApi): { session: AccountSession; state: Freshness } {
  const session = getAccountSession(api);
  let state = freshness.get(session);
  if (state === undefined) {
    state = { lastRead: Number.NEGATIVE_INFINITY, lastReadCooldown: REVALIDATION_FREQUENCY };
    freshness.set(session, state);
  }
  if (debounceSession !== session) {
    refreshDebouncer.clear();
    debounceSession = session;
  }
  return { session, state };
}

function cooldownFor(result: UserInfoRead): number {
  return result === "failed" ? FAILURE_COOLDOWN : REVALIDATION_FREQUENCY;
}

function readIsRecent(state: Freshness, within = state.lastReadCooldown): boolean {
  return Date.now() - state.lastRead < within;
}

/** Count actual user-info writes, including equal-value writes that ReduxWatcher omits. */
export function trackMembershipReads(api: IExtensionApi): void {
  let last = userInfo(api.getState());
  stateFor(api);
  api.store.subscribe(() => {
    const { state } = stateFor(api);
    const current = userInfo(api.getState());
    if (current === last) return;
    last = current;
    if (current === undefined) return; // clearing an account is not a successful membership read
    state.lastRead = Date.now();
    state.lastReadCooldown = REVALIDATION_FREQUENCY;
  });
}

export async function refreshMembership(api: IExtensionApi, nexus: Nexus): Promise<boolean> {
  const { state } = stateFor(api);
  if (state.inFlight !== undefined) return state.inFlight;
  return adoptMembershipRead(api, Promise.resolve(getUserInfo(api, nexus)));
}

/** Share the login's read with freshness checks, without adopting another account's work. */
export function adoptMembershipRead(
  api: IExtensionApi,
  read: Promise<UserInfoRead>,
): Promise<boolean> {
  const { session, state } = stateFor(api);
  if (state.inFlight !== undefined) return state.inFlight;
  const pending = read
    .catch((): UserInfoRead => "failed")
    .then((result) => {
      if (!isCurrentAccountSession(api, session)) return false;
      state.lastRead = Date.now();
      state.lastReadCooldown = cooldownFor(result);
      return result === "updated";
    })
    .finally(() => {
      if (state.inFlight === pending) state.inFlight = undefined;
    });
  state.inFlight = pending;
  return pending;
}

export async function ensureFreshMembership(api: IExtensionApi, nexus: Nexus): Promise<void> {
  const { state } = stateFor(api);
  if (!isLoggedIn(api.getState()) || readIsRecent(state)) return;
  await refreshMembership(api, nexus);
}

const refreshDebouncer = new Debouncer(
  (api: IExtensionApi, session: AccountSession) => {
    if (isCurrentAccountSession(api, session) && isLoggedIn(api.getState())) {
      api.events.emit("refresh-user-info");
    }
    return null;
  },
  REFRESH_DEBOUNCE,
  false,
  true,
);

/** Explicit triggers always ask; automatic hover/focus triggers can supply a freshness floor. */
export function scheduleMembershipRefresh(api: IExtensionApi, notReadWithin = 0): void {
  const { session, state } = stateFor(api);
  if (readIsRecent(state, notReadWithin)) return;
  refreshDebouncer.schedule(undefined, api, session);
}

/** Test seam: forget freshness and re-arm the debounce without retaining old session records. */
export function resetMembershipFreshness(): void {
  freshness = new WeakMap();
  debounceSession = undefined;
  refreshDebouncer.clear();
}
