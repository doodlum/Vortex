import PromiseBB from "bluebird";
import jwt from "jsonwebtoken";
import { describe, expect, vi } from "vitest";

import { test } from "@/test-utils/harnessTest";

import { onAPIKeyChanged, onOAuthTokenChanged } from "./eventHandlers";
import { ensureFreshMembership } from "./membership";
import { updateToken } from "./util";
import type * as nexusUtil from "./util";

// Importing eventHandlers reaches util/api, which builds Steam's singleton at module scope; see
// eventHandlers.onRefreshUserInfo.test.ts. Nothing here needs it.
vi.mock("@/util/Steam", () => ({ default: {} }));

// only whether the account's preferences are dropped matters here, not how the account is read
vi.mock("./util", async (importOriginal) => ({
  ...(await importOriginal<typeof nexusUtil>()),
  updateKey: vi.fn(),
  updateToken: vi.fn(() => Promise.resolve(true)),
  updateUserInfoFromRefreshedToken: vi.fn(),
}));

/** A client whose preferences cache can be watched being dropped. */
const makeNexus = () => {
  const clearPreferencesCache = vi.fn();
  return { nexus: { clearPreferencesCache } as never, clearPreferencesCache };
};

const credentials = (token: string, userId = 1) => ({
  token: jwt.sign(
    {
      application_id: 1,
      exp: 4102444800,
      iat: 1,
      iss: "nexusmods",
      jti: token,
      sub: String(userId),
      user: {
        group_id: 1,
        id: userId,
        joined: 0,
        membership_roles: [],
        other_group_ids: "",
        permissions: {},
        premium_expiry: 0,
        age_verified: true,
        username: "Inert account",
      },
    },
    "inert-unit-fixture",
  ),
  refreshToken: "refresh",
  fingerprint: "same-device",
});

describe("dropping the cached preferences", () => {
  test("drops them when the session ends, however it ended", ({ makeApi }) => {
    const { nexus, clearPreferencesCache } = makeNexus();

    onOAuthTokenChanged(makeApi().api, nexus)(credentials("a"), undefined);

    expect(clearPreferencesCache).toHaveBeenCalledTimes(1);
  });

  test("drops them when an account logs in, so it never sees the last one's", ({ makeApi }) => {
    const { nexus, clearPreferencesCache } = makeNexus();

    onOAuthTokenChanged(makeApi().api, nexus)(undefined, credentials("b"));

    expect(clearPreferencesCache).toHaveBeenCalledTimes(1);
  });

  test("keeps them through a token refresh, which is still the same account", ({ makeApi }) => {
    const { nexus, clearPreferencesCache } = makeNexus();

    onOAuthTokenChanged(makeApi().api, nexus)(credentials("a"), credentials("a2"));

    expect(clearPreferencesCache).not.toHaveBeenCalled();
  });

  test("drops them when the API key changes", ({ makeApi }) => {
    const { nexus, clearPreferencesCache } = makeNexus();

    onAPIKeyChanged(makeApi().api, nexus)("old", "new");

    expect(clearPreferencesCache).toHaveBeenCalledTimes(1);
  });
});

describe("replacement account credentials", () => {
  test("clears preferences and user info when another account replaces an existing token", ({
    makeApi,
  }) => {
    const harness = makeApi();
    const { nexus, clearPreferencesCache } = makeNexus();
    onOAuthTokenChanged(harness.api, nexus)(credentials("a", 1), credentials("b", 2));
    expect(clearPreferencesCache).toHaveBeenCalledOnce();
    expect(harness.getState().persistent["nexus"].userInfo).toBeUndefined();
  });
});

describe("login read ownership", () => {
  test("shares a fresh login validation with membership freshness checks", async ({ makeApi }) => {
    const harness = makeApi(),
      next = credentials("b", 2);
    harness.setState((draft) => {
      draft.confidential.account = { nexus: { OAuthCredentials: next } };
    });
    let finish!: (value: boolean) => void;
    const validation = new Promise<boolean>((resolve) => {
      finish = resolve;
    });
    vi.mocked(updateToken).mockReturnValueOnce(PromiseBB.resolve(validation));
    const getUserInfo = vi.fn().mockResolvedValue({
      sub: "2",
      name: "Account 2",
      email: "",
      avatar: "",
      membership_roles: [],
      preferences: {},
    });
    const client = { clearPreferencesCache: vi.fn(), getUserInfo };
    onOAuthTokenChanged(harness.api, client as never)(undefined, next);
    const pending = ensureFreshMembership(harness.api, client as never);
    finish(true);
    await pending;
    expect(getUserInfo).not.toHaveBeenCalled();
  });
});
