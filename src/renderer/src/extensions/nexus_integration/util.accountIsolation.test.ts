import { NexusError } from "@nexusmods/nexus-api";
import jwt from "jsonwebtoken";
import { describe, expect, vi } from "vitest";

import { makeUserInfo } from "@/test-utils/builders";
import type { IHarnessFixtures } from "@/test-utils/harnessTest";
import { test } from "@/test-utils/harnessTest";

import { getUserInfo, updateToken, updateKey } from "./util";

type Harness = ReturnType<IHarnessFixtures["makeApi"]>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function credentials(id: number, revision = "first") {
  return {
    token: jwt.sign(
      {
        application_id: 1,
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
        iss: "nexusmods",
        jti: `${id}-${revision}`,
        sub: String(id),
        user: {
          group_id: 1,
          id,
          joined: 0,
          membership_roles: [],
          other_group_ids: "",
          permissions: {},
          premium_expiry: 0,
          age_verified: true,
          username: `Account ${id}`,
        },
      },
      "inert-unit-fixture",
    ),
    refreshToken: `refresh-${id}-${revision}`,
    fingerprint: "same-device",
  };
}

function account(harness: Harness, id: number, revision = "first", name = `Account ${id}`) {
  const value = credentials(id, revision);
  harness.setState((draft) => {
    draft.confidential.account = { nexus: { OAuthCredentials: value } };
    draft.persistent["nexus"].userInfo = makeUserInfo({ userId: id, name });
  });
  return value;
}

const response = (id: number) => ({
  sub: String(id),
  name: `Server ${id}`,
  email: "",
  avatar: "",
  membership_roles: [],
  preferences: { adult: false, adultBlurImages: true },
});

describe("account-scoped user-info responses", () => {
  test("does not apply a late previous-account response", async ({ makeApi }) => {
    const harness = makeApi();
    account(harness, 1);
    const request = deferred<ReturnType<typeof response>>();
    const pending = getUserInfo(harness.api, { getUserInfo: () => request.promise } as never);
    account(harness, 2);
    request.resolve(response(1));
    await expect(pending).resolves.toBe("failed");
    expect(harness.getState().persistent["nexus"].userInfo?.name).toBe("Account 2");
  });

  test("does not resurrect an account after logout", async ({ makeApi }) => {
    const harness = makeApi();
    account(harness, 1);
    const request = deferred<ReturnType<typeof response>>();
    const pending = getUserInfo(harness.api, { getUserInfo: () => request.promise } as never);
    harness.setState((draft) => {
      draft.confidential.account = {};
      draft.persistent["nexus"].userInfo = undefined;
    });
    request.resolve(response(1));
    await expect(pending).resolves.toBe("failed");
    expect(harness.getState().persistent["nexus"].userInfo).toBeUndefined();
  });

  test("does not adopt an old response after switching away and back", async ({ makeApi }) => {
    const harness = makeApi();
    account(harness, 1);
    const request = deferred<ReturnType<typeof response>>();
    const pending = getUserInfo(harness.api, { getUserInfo: () => request.promise } as never);
    account(harness, 2);
    account(harness, 1, "fresh-login", "New session 1");
    request.resolve(response(1));
    await expect(pending).resolves.toBe("failed");
    expect(harness.getState().persistent["nexus"].userInfo?.name).toBe("New session 1");
  });

  test("keeps a response valid through a same-account token refresh", async ({ makeApi }) => {
    const harness = makeApi();
    account(harness, 1);
    const request = deferred<ReturnType<typeof response>>();
    const pending = getUserInfo(harness.api, { getUserInfo: () => request.promise } as never);
    account(harness, 1, "refreshed");
    request.resolve(response(1));
    await expect(pending).resolves.toBe("updated");
    expect(harness.getState().persistent["nexus"].userInfo?.name).toBe("Server 1");
  });

  test("does not apply a late login validation to another account", async ({ makeApi }) => {
    const harness = makeApi();
    const first = account(harness, 1);
    const entered = deferred<void>(),
      request = deferred<ReturnType<typeof response>>();
    const client = {
      setTokenProvider: vi.fn().mockResolvedValue(undefined),
      getUserInfo: () => {
        entered.resolve(undefined);
        return request.promise;
      },
    };
    const pending = updateToken(harness.api, client as never, first);
    await entered.promise;
    account(harness, 2);
    request.resolve(response(1));
    await expect(pending).resolves.toBe(false);
    expect(harness.getState().persistent["nexus"].userInfo?.name).toBe("Account 2");
  });

  test("does not sign another account out on a late validation refusal", async ({ makeApi }) => {
    const harness = makeApi();
    const first = account(harness, 1);
    const entered = deferred<void>(),
      request = deferred<ReturnType<typeof response>>();
    const client = {
      setTokenProvider: vi.fn().mockResolvedValue(undefined),
      getUserInfo: () => {
        entered.resolve(undefined);
        return request.promise;
      },
    };
    const pending = updateToken(harness.api, client as never, first);
    await entered.promise;
    const second = account(harness, 2);
    request.reject(
      new NexusError("Unauthorized", 401, "https://api.nexusmods.com", "unauthorized"),
    );
    await expect(pending).resolves.toBe(false);
    expect(harness.getState().confidential.account["nexus"].OAuthCredentials).toEqual(second);
    expect(harness.getState().persistent["nexus"].userInfo?.name).toBe("Account 2");
    expect(harness.errorNotifications).toEqual([]);
  });

  test("does not start an old validation after the token provider finishes priming", async ({
    makeApi,
  }) => {
    const harness = makeApi();
    const first = account(harness, 1);
    const priming = deferred<void>();
    const client = {
      setTokenProvider: () => priming.promise,
      getUserInfo: vi.fn().mockResolvedValue(response(1)),
    };
    const pending = updateToken(harness.api, client as never, first);
    account(harness, 2);
    priming.resolve(undefined);
    await expect(pending).resolves.toBe(false);
    expect(client.getUserInfo).not.toHaveBeenCalled();
    expect(harness.getState().persistent["nexus"].userInfo?.name).toBe("Account 2");
  });
});

describe("API-key validation isolation", () => {
  function keyAccount(harness: Harness, key: string, id: number) {
    harness.setState((draft) => {
      draft.confidential.account = { nexus: { APIKey: key } };
      draft.persistent["nexus"].userInfo = makeUserInfo({ userId: id, name: `Key account ${id}` });
    });
  }

  test("does not clear the replacement account on a late API-key refusal", async ({ makeApi }) => {
    const harness = makeApi();
    keyAccount(harness, "inert-key-a", 1);
    const request = deferred<void>();
    const pending = updateKey(
      harness.api,
      { setKey: () => request.promise } as never,
      "inert-key-a",
    );
    keyAccount(harness, "inert-key-b", 2);
    request.reject(
      new NexusError("Unauthorized", 401, "https://api.nexusmods.com", "unauthorized"),
    );
    await expect(pending).resolves.toBe(false);
    expect(harness.getState().persistent["nexus"].userInfo?.name).toBe("Key account 2");
    expect(harness.notifications).toEqual([]);
  });

  test("does not report a stale API-key validation as current success", async ({ makeApi }) => {
    const harness = makeApi();
    keyAccount(harness, "inert-key-a", 1);
    const request = deferred<void>();
    const pending = updateKey(
      harness.api,
      { setKey: () => request.promise } as never,
      "inert-key-a",
    );
    keyAccount(harness, "inert-key-b", 2);
    request.resolve(undefined);
    await expect(pending).resolves.toBe(false);
  });

  test("does not replay an obsolete API-key retry in the new account", async ({ makeApi }) => {
    const harness = makeApi();
    keyAccount(harness, "inert-key-a", 1);
    const client = {
      setKey: vi
        .fn()
        .mockRejectedValueOnce(
          new NexusError("Unauthorized", 401, "https://api.nexusmods.com", "unauthorized"),
        )
        .mockResolvedValue(undefined),
    };
    await updateKey(harness.api, client as never, "inert-key-a");
    const retry = harness.notifications[0].actions![0].action,
      dismiss = vi.fn();
    keyAccount(harness, "inert-key-b", 2);
    retry(dismiss);
    expect(client.setKey).toHaveBeenCalledTimes(1);
    expect(dismiss).toHaveBeenCalledOnce();
  });

  test("retains a current account's refusal diagnostic and retry", async ({ makeApi }) => {
    const harness = makeApi();
    keyAccount(harness, "inert-key-a", 1);
    const client = {
      setKey: vi
        .fn()
        .mockRejectedValueOnce(
          new NexusError("Unauthorized", 401, "https://api.nexusmods.com", "unauthorized"),
        )
        .mockResolvedValue(undefined),
    };
    await expect(updateKey(harness.api, client as never, "inert-key-a")).resolves.toBe(false);
    expect(harness.notifications[0].title).toBe("Failed to log in");
    harness.notifications[0].actions![0].action(vi.fn());
    expect(client.setKey).toHaveBeenCalledTimes(2);
  });
});
