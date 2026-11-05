import Nexus from "@nexusmods/nexus-api";
import PromiseBB from "bluebird";
import jwt from "jsonwebtoken";
import { afterEach, describe, expect, vi } from "vitest";

import type { IHarnessFixtures } from "@/test-utils/harnessTest";
import { test } from "@/test-utils/harnessTest";
import { ProcessCanceled } from "@/util/CustomErrors";

import { createAccountClient } from "./accountClient";

type Harness = ReturnType<IHarnessFixtures["makeApi"]>;
const nativePromise = Promise;
const query = { adult: true as const };
const firstPreferences = { adult: true, adultBlurImages: false };
const secondPreferences = { adult: false, adultBlurImages: true };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

function account(harness: Harness, id: number, revision = "initial") {
  const token = jwt.sign(
    {
      application_id: 1,
      exp: 4102444800,
      iat: 1,
      iss: "nexusmods",
      jti: revision,
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
  );
  harness.setState((draft) => {
    draft.confidential.account = {
      nexus: {
        OAuthCredentials: {
          token,
          refreshToken: `refresh-${id}-${revision}`,
          fingerprint: "same-device",
        },
      },
    };
  });
}

function client(harness: Harness) {
  const graph = vi.fn();
  const create = () => {
    const raw = new Nexus("Inert unit fixture", "1.0.0", "fixture", 30000);
    Object.assign(raw, {
      mQuota: { wait: () => Promise.resolve() },
      args: (value: unknown) => value,
      filter: (value: unknown) => value,
      requestGraph: graph,
      request: () => Promise.resolve({ sub: "2", name: "Account 2" }),
    });
    return raw;
  };
  return {
    graph,
    nexus: createAccountClient(harness.api, create, new Set(["getPreferences", "getUserInfo"])),
  };
}

describe.each([
  ["native", nativePromise],
  ["Bluebird", PromiseBB],
] as const)("%s account preferences", (_name, promise) => {
  afterEach(() => vi.unstubAllGlobals());
  test("rejects a late previous-account preference response", async ({ makeApi }) => {
    vi.stubGlobal("Promise", promise);
    const harness = makeApi();
    account(harness, 1);
    const { nexus, graph } = client(harness),
      entered = deferred<void>(),
      old = deferred<typeof firstPreferences>();
    graph.mockImplementationOnce(() => {
      entered.resolve(undefined);
      return old.promise;
    });
    const result = nexus.getPreferences(query).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await entered.promise;
    account(harness, 2);
    nexus.clearPreferencesCache();
    old.resolve(firstPreferences);
    expect(await result).toEqual({ error: expect.any(ProcessCanceled) });
  });

  test("never reuses the SDK cache repopulated by the previous account", async ({ makeApi }) => {
    vi.stubGlobal("Promise", promise);
    const harness = makeApi();
    account(harness, 1);
    const { nexus, graph } = client(harness),
      entered = deferred<void>(),
      old = deferred<typeof firstPreferences>();
    graph
      .mockImplementationOnce(() => {
        entered.resolve(undefined);
        return old.promise;
      })
      .mockResolvedValueOnce(secondPreferences);
    const pending = nexus.getPreferences(query).catch(() => undefined);
    await entered.promise;
    account(harness, 2);
    nexus.clearPreferencesCache();
    old.resolve(firstPreferences);
    await pending;
    await expect(nexus.getPreferences(query)).resolves.toEqual(secondPreferences);
    expect(graph).toHaveBeenCalledTimes(2);
  });

  test("keeps a new account's completed cache when the old response arrives later", async ({
    makeApi,
  }) => {
    vi.stubGlobal("Promise", promise);
    const harness = makeApi();
    account(harness, 1);
    const { nexus, graph } = client(harness),
      entered = deferred<void>(),
      old = deferred<typeof firstPreferences>();
    graph
      .mockImplementationOnce(() => {
        entered.resolve(undefined);
        return old.promise;
      })
      .mockResolvedValueOnce(secondPreferences);
    const pending = nexus.getPreferences(query).catch(() => undefined);
    await entered.promise;
    account(harness, 2);
    nexus.clearPreferencesCache();
    await expect(nexus.getPreferences(query)).resolves.toEqual(secondPreferences);
    old.resolve(firstPreferences);
    await pending;
    await expect(nexus.getPreferences(query)).resolves.toEqual(secondPreferences);
    expect(graph).toHaveBeenCalledTimes(2);
  });

  test("preserves cached preferences through a same-account token refresh", async ({ makeApi }) => {
    vi.stubGlobal("Promise", promise);
    const harness = makeApi();
    account(harness, 1);
    const { nexus, graph } = client(harness);
    graph.mockResolvedValue(firstPreferences);
    await nexus.getPreferences(query);
    account(harness, 1, "refreshed");
    await expect(nexus.getPreferences(query)).resolves.toEqual(firstPreferences);
    expect(graph).toHaveBeenCalledTimes(1);
  });

  test("shares an in-flight preference read within the same account", async ({ makeApi }) => {
    vi.stubGlobal("Promise", promise);
    const harness = makeApi();
    account(harness, 1);
    const { nexus, graph } = client(harness),
      old = deferred<typeof firstPreferences>();
    graph.mockReturnValue(old.promise);
    const first = nexus.getPreferences(query),
      second = nexus.getPreferences(query);
    old.resolve(firstPreferences);
    await expect(Promise.all([first, second])).resolves.toEqual([
      firstPreferences,
      firstPreferences,
    ]);
    expect(graph).toHaveBeenCalledTimes(1);
  });

  test("keeps distinct preference queries separate", async ({ makeApi }) => {
    vi.stubGlobal("Promise", promise);
    const harness = makeApi();
    account(harness, 1);
    const { nexus, graph } = client(harness);
    graph.mockResolvedValueOnce({ adult: true }).mockResolvedValueOnce({ adultBlurImages: true });
    await expect(nexus.getPreferences(query)).resolves.toEqual({ adult: true });
    await expect(nexus.getPreferences({ adultBlurImages: true })).resolves.toEqual({
      adultBlurImages: true,
    });
    expect(graph).toHaveBeenCalledTimes(2);
  });

  test("honors explicit cache bypass and preserves synchronous cache clearing", async ({
    makeApi,
  }) => {
    vi.stubGlobal("Promise", promise);
    const harness = makeApi();
    account(harness, 1);
    const { nexus, graph } = client(harness);
    graph.mockResolvedValueOnce(firstPreferences).mockResolvedValueOnce(secondPreferences);
    await nexus.getPreferences(query);
    await expect(nexus.getPreferences(query, false)).resolves.toEqual(secondPreferences);
    expect(nexus.clearPreferencesCache()).toBeUndefined();
    expect(graph).toHaveBeenCalledTimes(2);
  });

  test("does not request private preferences after logout", async ({ makeApi }) => {
    vi.stubGlobal("Promise", promise);
    const harness = makeApi();
    account(harness, 1);
    const { nexus, graph } = client(harness);
    graph.mockResolvedValue(firstPreferences);
    harness.setState((draft) => {
      draft.confidential.account = {};
    });
    await expect(nexus.getPreferences(query)).rejects.toBeInstanceOf(ProcessCanceled);
    expect(graph).not.toHaveBeenCalled();
  });

  test("covers the SDK's internal preference call from getUserInfo", async ({ makeApi }) => {
    vi.stubGlobal("Promise", promise);
    const harness = makeApi();
    account(harness, 1);
    const { nexus, graph } = client(harness),
      entered = deferred<void>(),
      old = deferred<typeof firstPreferences>();
    graph
      .mockImplementationOnce(() => {
        entered.resolve(undefined);
        return old.promise;
      })
      .mockResolvedValueOnce(secondPreferences);
    const pending = nexus.getUserInfo().catch(() => undefined);
    await entered.promise;
    account(harness, 2);
    nexus.clearPreferencesCache();
    old.resolve(firstPreferences);
    await pending;
    const current = await nexus.getUserInfo();
    expect(current.preferences).toEqual(secondPreferences);
    expect(graph).toHaveBeenCalledTimes(2);
  });
  test("retries a preference read after a passing network failure", async ({ makeApi }) => {
    vi.stubGlobal("Promise", promise);
    const harness = makeApi();
    account(harness, 1);
    const { nexus, graph } = client(harness);
    graph
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce(secondPreferences);
    await expect(nexus.getPreferences(query)).rejects.toThrow("network unavailable");
    await expect(nexus.getPreferences(query)).resolves.toEqual(secondPreferences);
    expect(graph).toHaveBeenCalledTimes(2);
  });
});
