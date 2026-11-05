import jwt from "jsonwebtoken";
import { describe, expect, vi } from "vitest";

import { makeUserInfo } from "@/test-utils/builders";
import type { IHarnessFixtures } from "@/test-utils/harnessTest";
import { test } from "@/test-utils/harnessTest";
import { ProcessCanceled } from "@/util/CustomErrors";

import { clearOAuthCredentials, setOAuthCredentials } from "../actions/account";
import type * as oauthModule from "./oauth";
import { requestTokenRefresh } from "./oauth";
import { getAccessToken, tokenProviderFor } from "./oauthSession";

// util.ts (pulled in by the harness) builds the real OAuth class, so mock only the refresh
vi.mock("./oauth", async (importOriginal) => ({
  ...(await importOriginal<typeof oauthModule>()),
  requestTokenRefresh: vi.fn(),
}));

const refreshMock = vi.mocked(requestTokenRefresh);

/**
 * An access token as the site issues it, expiring `secondsLeft` from now. Nothing verifies the
 * signature; the claims are read as they are.
 */
const makeToken = (secondsLeft: number, id = "t", userId = 7) =>
  jwt.sign(
    {
      application_id: 1,
      exp: Math.floor(Date.now() / 1000) + secondsLeft,
      fingerprint: `fp-${id}`,
      iat: Math.floor(Date.now() / 1000),
      iss: "nexusmods",
      jti: id,
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
        username: "Ada",
      },
    },
    "not-verified-here",
  );

const reply = (accessToken: string, refreshToken = "refresh-2") => ({
  access_token: accessToken,
  refresh_token: refreshToken,
  token_type: "Bearer" as const,
  expires_in: 3600,
  scope: "openid",
});

/** The token endpoint's answer to a refresh token it no longer recognises. */
const invalidGrant = () =>
  Object.assign(new Error('Invalid request: "invalid_grant"'), { code: "invalid_grant" });

type Harness = ReturnType<IHarnessFixtures["makeApi"]>;

function logIn(harness: Harness, token: string, refreshToken = "refresh-1") {
  harness.api.store.dispatch(setOAuthCredentials(token, refreshToken, "fp-1"));
}

const storedCredentials = (harness: Harness) =>
  harness.getState().confidential.account["nexus"].OAuthCredentials;

describe("getAccessToken", () => {
  test("hands out the current token while it is fresh", async ({ makeApi }) => {
    const harness = makeApi();
    const token = makeToken(3600);
    logIn(harness, token);

    await expect(getAccessToken(harness.api)).resolves.toBe(token);
    expect(refreshMock).not.toHaveBeenCalled();
  });

  test("is undefined without an OAuth session", async ({ makeApi }) => {
    const harness = makeApi();
    harness.api.store.dispatch(clearOAuthCredentials(null));

    await expect(getAccessToken(harness.api)).resolves.toBeUndefined();
  });

  test("refreshes ahead of expiry and stores the new pair", async ({ makeApi }) => {
    const harness = makeApi();
    logIn(harness, makeToken(10));
    const renewed = makeToken(3600, "renewed");
    refreshMock.mockResolvedValueOnce(reply(renewed));

    await expect(getAccessToken(harness.api)).resolves.toBe(renewed);

    expect(refreshMock).toHaveBeenCalledWith("refresh-1");
    expect(storedCredentials(harness)).toEqual({
      token: renewed,
      refreshToken: "refresh-2",
      fingerprint: "fp-renewed",
    });
  });

  test("shares one refresh between callers who need it at the same time", async ({ makeApi }) => {
    const harness = makeApi();
    logIn(harness, makeToken(10));
    const renewed = makeToken(3600, "renewed");
    let release: (value: ReturnType<typeof reply>) => void = () => undefined;
    refreshMock.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));

    const first = getAccessToken(harness.api);
    const second = getAccessToken(harness.api);
    release(reply(renewed));

    await expect(Promise.all([first, second])).resolves.toEqual([renewed, renewed]);
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  test("hands out the current token when a refresh fails for a passing reason", async ({
    makeApi,
  }) => {
    const harness = makeApi({ userInfo: makeUserInfo({ name: "Ada" }) });
    const token = makeToken(10);
    logIn(harness, token);
    refreshMock.mockRejectedValueOnce(
      Object.assign(new Error("getaddrinfo ENOTFOUND users.nexusmods.com"), { code: "ENOTFOUND" }),
    );

    await expect(getAccessToken(harness.api)).resolves.toBe(token);

    expect(storedCredentials(harness)?.token).toBe(token);
    expect(harness.errorNotifications).toEqual([]);
  });

  test("hands out no token when a refresh ahead of expiry is refused", async ({ makeApi }) => {
    const harness = makeApi({ userInfo: makeUserInfo({ name: "Ada" }) });
    logIn(harness, makeToken(10));
    refreshMock.mockRejectedValueOnce(invalidGrant());

    await expect(getAccessToken(harness.api)).resolves.toBeUndefined();

    expect(storedCredentials(harness)).toBeUndefined();
  });

  test("forces a refresh for a rejected token while it is still the current one", async ({
    makeApi,
  }) => {
    const harness = makeApi();
    const token = makeToken(3600);
    logIn(harness, token);
    const renewed = makeToken(3600, "renewed");
    refreshMock.mockResolvedValueOnce(reply(renewed));

    await expect(getAccessToken(harness.api, token)).resolves.toBe(renewed);
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  test("answers a rejected token that was already replaced with the current one", async ({
    makeApi,
  }) => {
    const harness = makeApi();
    const token = makeToken(3600);
    logIn(harness, token);

    await expect(getAccessToken(harness.api, makeToken(3600, "older"))).resolves.toBe(token);
    expect(refreshMock).not.toHaveBeenCalled();
  });

  test("signs the user out and rejects when the refresh is refused", async ({ makeApi }) => {
    const harness = makeApi({ userInfo: makeUserInfo({ name: "Ada" }) });
    const token = makeToken(3600);
    logIn(harness, token);
    refreshMock.mockRejectedValueOnce(invalidGrant());

    await expect(getAccessToken(harness.api, token)).rejects.toMatchObject({
      code: "invalid_grant",
    });

    expect(storedCredentials(harness)).toBeUndefined();
    expect(harness.getState().persistent["nexus"].userInfo).toBeUndefined();
    expect(harness.errorNotifications).toEqual([
      expect.objectContaining({ title: "Authentication failed, please log in again" }),
    ]);
  });

  test("does not resurrect a session that ended while the refresh was out", async ({ makeApi }) => {
    const harness = makeApi();
    logIn(harness, makeToken(10));
    let release: (value: ReturnType<typeof reply>) => void = () => undefined;
    refreshMock.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));

    const pending = getAccessToken(harness.api);
    logIn(harness, makeToken(3600, "other"), "refresh-other");
    release(reply(makeToken(3600, "renewed")));

    await expect(pending).resolves.toBe(storedCredentials(harness)?.token);
    expect(storedCredentials(harness)?.refreshToken).toBe("refresh-other");
  });
});

describe("account-isolated token refresh", () => {
  function pendingReply() {
    let resolve!: (value: ReturnType<typeof reply>) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<ReturnType<typeof reply>>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    return { promise, resolve, reject };
  }

  test("does not sign the new account out when the old refresh is refused", async ({ makeApi }) => {
    const harness = makeApi(),
      old = pendingReply();
    logIn(harness, makeToken(10, "account-a", 7), "refresh-a");
    refreshMock.mockReturnValueOnce(old.promise);
    const pending = getAccessToken(harness.api);
    const current = makeToken(3600, "account-b", 8);
    logIn(harness, current, "refresh-b");
    old.reject(invalidGrant());
    await expect(pending).resolves.toBeUndefined();
    expect(storedCredentials(harness)?.token).toBe(current);
    expect(storedCredentials(harness)?.refreshToken).toBe("refresh-b");
    expect(harness.errorNotifications).toEqual([]);
  });

  test("does not share a previous account's pending refresh with the new account", async ({
    makeApi,
  }) => {
    const harness = makeApi(),
      old = pendingReply(),
      fresh = pendingReply();
    const renewedA = makeToken(3600, "renewed-a", 7),
      renewedB = makeToken(3600, "renewed-b", 8);
    refreshMock.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    logIn(harness, makeToken(10, "account-a", 7), "refresh-a");
    const first = getAccessToken(harness.api);
    logIn(harness, makeToken(10, "account-b", 8), "refresh-b");
    const second = getAccessToken(harness.api);
    old.resolve(reply(renewedA, "renewed-refresh-a"));
    fresh.resolve(reply(renewedB, "renewed-refresh-b"));
    const results = await Promise.all([first, second]);
    expect(refreshMock).toHaveBeenCalledTimes(2);
    expect(results).toEqual([undefined, renewedB]);
    expect(storedCredentials(harness)?.token).toBe(renewedB);
    expect(storedCredentials(harness)?.refreshToken).toBe("renewed-refresh-b");
  });

  test("does not hand another account's token to a rejected old-account request", async ({
    makeApi,
  }) => {
    const harness = makeApi();
    const old = makeToken(3600, "account-a", 7);
    logIn(harness, makeToken(3600, "account-b", 8), "refresh-b");
    await expect(getAccessToken(harness.api, old)).resolves.toBeUndefined();
    expect(refreshMock).not.toHaveBeenCalled();
  });
});

describe("reviewed asynchronous account boundaries", () => {
  test("does not return the replacement token after a refresh-error microtask gap", async ({
    makeApi,
  }) => {
    const harness = makeApi();
    logIn(harness, makeToken(10, "a", 7), "refresh-a");
    let reject!: (error: unknown) => void;
    refreshMock.mockReturnValueOnce(
      new Promise((_resolve, no) => {
        reject = no;
      }),
    );
    const pending = getAccessToken(harness.api);
    reject(new Error("network unavailable"));
    queueMicrotask(() => logIn(harness, makeToken(3600, "b", 8), "refresh-b"));
    await expect(pending).resolves.toBeUndefined();
    expect(storedCredentials(harness)?.refreshToken).toBe("refresh-b");
  });

  test("a retired SDK provider rejects instead of supplying another account's token", async ({
    makeApi,
  }) => {
    const harness = makeApi();
    logIn(harness, makeToken(3600, "a", 7), "refresh-a");
    const provider = tokenProviderFor(harness.api);
    logIn(harness, makeToken(3600, "b", 8), "refresh-b");
    await expect(provider()).rejects.toBeInstanceOf(ProcessCanceled);
  });

  test("a provider remains usable through a same-account token refresh", async ({ makeApi }) => {
    const harness = makeApi();
    logIn(harness, makeToken(3600, "a", 7), "refresh-a");
    const provider = tokenProviderFor(harness.api),
      renewed = makeToken(3600, "renewed", 7);
    logIn(harness, renewed, "refresh-renewed");
    await expect(provider()).resolves.toBe(renewed);
  });
});
