import { beforeEach, describe, expect, vi } from "vitest";

import { test } from "@/test-utils/harnessTest";
import type { IHarnessFixtures } from "@/test-utils/harnessTest";

import { ensureFreshMembership, refreshMembership, resetMembershipFreshness } from "./membership";

type Harness = ReturnType<IHarnessFixtures["makeApi"]>;
function account(harness: Harness, id: number) {
  harness.setState((draft) => {
    draft.confidential.account = { nexus: { OAuthCredentials: { token: `inert-account-${id}` } } };
  });
}
const response = (id: number) => ({
  sub: String(id),
  name: `Server ${id}`,
  email: "",
  avatar: "",
  membership_roles: [],
  preferences: {},
});
function deferred() {
  let resolve!: (value: ReturnType<typeof response>) => void;
  const promise = new Promise<ReturnType<typeof response>>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

describe("account-isolated membership freshness", () => {
  beforeEach(() => resetMembershipFreshness());

  test("does not share a previous account's pending membership read", async ({ makeApi }) => {
    const harness = makeApi(),
      old = deferred();
    account(harness, 1);
    const getUserInfo = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue(response(2));
    const client = { getUserInfo } as never;
    const first = refreshMembership(harness.api, client);
    account(harness, 2);
    const second = refreshMembership(harness.api, client);
    old.resolve(response(1));
    const result = await Promise.all([first, second]);
    expect(getUserInfo).toHaveBeenCalledTimes(2);
    expect(result).toEqual([false, true]);
  });

  test("does not treat the previous account's cooldown as current membership", async ({
    makeApi,
  }) => {
    const harness = makeApi();
    account(harness, 1);
    const getUserInfo = vi
      .fn()
      .mockResolvedValueOnce(response(1))
      .mockResolvedValueOnce(response(2));
    const client = { getUserInfo } as never;
    await ensureFreshMembership(harness.api, client);
    account(harness, 2);
    await ensureFreshMembership(harness.api, client);
    expect(getUserInfo).toHaveBeenCalledTimes(2);
    expect(harness.getState().persistent["nexus"].userInfo?.name).toBe("Server 2");
  });

  test("keeps the new account's in-flight read when the old one completes", async ({ makeApi }) => {
    const harness = makeApi(),
      old = deferred(),
      fresh = deferred();
    account(harness, 1);
    const getUserInfo = vi
      .fn()
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(fresh.promise)
      .mockResolvedValue(response(2));
    const client = { getUserInfo } as never;
    const first = refreshMembership(harness.api, client);
    account(harness, 2);
    const second = refreshMembership(harness.api, client);
    old.resolve(response(1));
    await first;
    const third = refreshMembership(harness.api, client);
    fresh.resolve(response(2));
    const result = await Promise.all([second, third]);
    expect(getUserInfo).toHaveBeenCalledTimes(2);
    expect(result).toEqual([true, true]);
  });
});
