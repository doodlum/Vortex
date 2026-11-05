import { EventEmitter } from "node:events";
import fs from "node:fs";
import https from "node:https";
import { PassThrough, Writable } from "node:stream";

import Nexus from "@nexusmods/nexus-api";
import jwt from "jsonwebtoken";
import { describe, expect, vi } from "vitest";

import type { IHarnessFixtures } from "@/test-utils/harnessTest";
import { test } from "@/test-utils/harnessTest";
import { ProcessCanceled } from "@/util/CustomErrors";

import { createAccountClient } from "./accountClient";
import { requestFuncs } from "./requestMethods";

type Harness = ReturnType<IHarnessFixtures["makeApi"]>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function token(id: number, revision = "first") {
  return jwt.sign(
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
}
function account(harness: Harness, id: number, revision = "first") {
  const value = token(id, revision);
  harness.setState((draft) => {
    draft.confidential.account = {
      nexus: {
        OAuthCredentials: {
          token: value,
          refreshToken: `refresh-${id}`,
          fingerprint: "same-device",
        },
      },
    };
  });
  return value;
}
function fixture(harness: Harness, quota?: ReturnType<typeof deferred<void>>) {
  const instances: Array<{
    sdk: Nexus;
    request: ReturnType<typeof vi.fn>;
    base: { headers: Record<string, unknown>; path: Record<string, unknown> };
  }> = [];
  const entered = deferred<void>();
  const validateKey = vi.fn().mockResolvedValue({ name: "Key B", user_id: 2 });
  const make = () => {
    const sdk = new Nexus("Inert unit fixture", "1.0.0", "fixture", 30000);
    const base = { headers: {}, path: {} };
    const request = vi.fn().mockImplementation(() => {
      expect(sdk.getValidationResult()).toBeDefined();
      return Promise.resolve({ mod_id: 1 });
    });
    Object.assign(sdk, {
      mBaseData: base,
      mLogCB: () => undefined,
      mQuota: {
        wait: () => {
          entered.resolve(undefined);
          return quota?.promise ?? Promise.resolve();
        },
      },
      request,
      requestGraph: vi.fn().mockResolvedValue({ adult: false }),
      validateKey,
      args: (value: unknown) => value,
      filter: (value: unknown) => value,
    });
    instances.push({ sdk, request, base });
    return sdk;
  };
  return {
    nexus: createAccountClient(
      harness.api,
      make,
      new Set(["getModInfo", "getUserInfo", "getPreferences"]),
    ),
    instances,
    entered,
    validateKey,
  };
}

describe("account-owned SDK instances", () => {
  test("late actual SDK token priming cannot erase the replacement validation result", async ({
    makeApi,
  }) => {
    const harness = makeApi(),
      old = deferred<string | undefined>();
    account(harness, 1);
    const { nexus, instances } = fixture(harness);
    const pending = nexus.setTokenProvider(() => old.promise).catch((error) => error);
    const next = account(harness, 2);
    await nexus.setTokenProvider(async () => next);
    const expected = nexus.getValidationResult();
    expect(expected).toBeDefined();
    old.resolve(undefined);
    await pending;
    expect(nexus.getValidationResult()).toEqual(expected);
    expect(instances).toHaveLength(2);
  });

  test("late actual SDK key validation cannot replace the new account's result", async ({
    makeApi,
  }) => {
    const harness = makeApi(),
      old = deferred<unknown>();
    harness.setState((draft) => {
      draft.confidential.account = { nexus: { APIKey: "inert-key-a" } };
    });
    const { nexus, validateKey } = fixture(harness);
    validateKey
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce({ name: "Key B", user_id: 2 });
    const pending = nexus.setKey("inert-key-a").catch((error) => error);
    harness.setState((draft) => {
      draft.confidential.account = { nexus: { APIKey: "inert-key-b" } };
    });
    await nexus.setKey("inert-key-b");
    const expected = nexus.getValidationResult();
    old.resolve({ name: "Key A", user_id: 1 });
    await pending;
    expect(nexus.getValidationResult()).toEqual(expected);
  });

  test("authenticates a new current SDK before its first network consumer", async ({ makeApi }) => {
    const harness = makeApi();
    account(harness, 1);
    const { nexus, instances } = fixture(harness);
    await expect(nexus.getModInfo(1, "fixture")).resolves.toEqual({ mod_id: 1 });
    expect(instances[0].request).toHaveBeenCalledOnce();
  });

  test("rejects a retired queued request before sending it", async ({ makeApi }) => {
    const harness = makeApi(),
      quota = deferred<void>();
    account(harness, 1);
    const { nexus, instances, entered } = fixture(harness, quota);
    await nexus.setTokenProvider(async () => token(1));
    const pending = nexus.getModInfo(1, "fixture").then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await entered.promise;
    account(harness, 2);
    quota.resolve(undefined);
    expect(await pending).toEqual({ error: expect.any(ProcessCanceled) });
    expect(instances[0].request).not.toHaveBeenCalled();
  });

  test("retires the caller even when an SDK quota wait has not finished", async ({ makeApi }) => {
    const harness = makeApi(),
      quota = deferred<void>();
    account(harness, 1);
    const { nexus, entered } = fixture(harness, quota);
    await nexus.setTokenProvider(async () => token(1));
    let outcome: unknown;
    const pending = nexus.getModInfo(1, "fixture").then(
      (value) => {
        outcome = value;
      },
      (error) => {
        outcome = error;
      },
    );
    await entered.promise;
    account(harness, 2);
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(outcome).toBeInstanceOf(ProcessCanceled);
    } finally {
      quota.resolve(undefined);
      await pending;
    }
  });

  test("selects at invocation and carries logger/game while keeping sync management sync", async ({
    makeApi,
  }) => {
    const harness = makeApi();
    account(harness, 1);
    const { nexus, instances } = fixture(harness),
      logger = vi.fn();
    const retained = nexus.getModInfo.bind(nexus);
    expect(nexus.setLogger(logger)).toBeUndefined();
    expect(nexus.setGame("stardewvalley")).toBeUndefined();
    harness.setState((draft) => {
      draft.confidential.account = { nexus: { APIKey: "inert-key-b" } };
    });
    await nexus.setKey("inert-key-b");
    await retained(1, "fixture");
    expect(instances).toHaveLength(2);
    expect(instances[1].base.path.gameId).toBe("stardewvalley");
    expect(logger).toHaveBeenCalled();
    expect(nexus.getValidationResult()).not.toBeInstanceOf(Promise);
    expect(nexus.clearPreferencesCache()).toBeUndefined();
  });

  test("keeps the same SDK through a same-account refresh", async ({ makeApi }) => {
    const harness = makeApi();
    const first = account(harness, 1);
    const { nexus, instances } = fixture(harness);
    await nexus.setTokenProvider(async () => first);
    const refreshed = account(harness, 1, "refreshed");
    await nexus.setTokenProvider(async () => refreshed);
    expect(instances).toHaveLength(1);
  });
});

describe("SDK transport boundaries", () => {
  const graphCalls = [
    ["searchCollectionsGraph", [{ name: true }, { gameId: "fixture" }]],
    ["modFileContents", [{ nodes: true }]],
    ["sendMetric", ["view", "mod", "1", {}]],
    ["modRequirements", [{ nexusRequirements: true }, 1, "fixture"]],
    ["userById", [{ name: true }, 1]],
    ["getMyCollections", [{ name: true }, "fixture"]],
  ] as const;
  test.for(graphCalls)(
    "authenticates the current SDK before %s",
    async ([method, args], { makeApi }) => {
      const harness = makeApi();
      account(harness, 1);
      const network = vi.fn();
      const make = () => {
        const sdk = new Nexus("Inert unit fixture", "1.0.0", "fixture", 30000);
        const graph = () => {
          expect(sdk.getValidationResult()).toBeDefined();
          network();
          return Promise.resolve([]);
        };
        Object.assign(sdk, {
          mQuota: { wait: () => Promise.resolve() },
          requestGraph: graph,
          mutateGraph: graph,
        });
        return sdk;
      };
      const nexus = createAccountClient(
        harness.api,
        make,
        new Set([...requestFuncs, "getPreferences"]),
      );
      await (nexus[method] as (...values: unknown[]) => Promise<unknown>)(...args);
      account(harness, 2);
      await (nexus[method] as (...values: unknown[]) => Promise<unknown>)(...args);
      expect(network).toHaveBeenCalledTimes(2);
    },
  );

  test("an already-sent response can finish retired SDK rate-limit bookkeeping without throwing", async ({
    makeApi,
  }) => {
    const harness = makeApi();
    account(harness, 1);
    let respond!: (response: unknown) => void;
    const entered = deferred<void>();
    const request = new EventEmitter();
    const get = vi.spyOn(https, "get").mockImplementation(((
      _options: unknown,
      callback: (response: unknown) => void,
    ) => {
      respond = callback;
      entered.resolve(undefined);
      return request;
    }) as typeof https.get);
    const instances: Nexus[] = [];
    const make = () => {
      const sdk = new Nexus("Inert unit fixture", "1.0.0", "fixture", 30000);
      Object.assign(sdk, {
        mQuota: { wait: () => Promise.resolve(), updateLimit: vi.fn(), finishInit: vi.fn() },
      });
      instances.push(sdk);
      return sdk;
    };
    try {
      const nexus = createAccountClient(harness.api, make, requestFuncs);
      const pending = nexus.getModInfo(1, "fixture").catch((error) => error);
      await entered.promise;
      account(harness, 2);
      const currentLimits = nexus.getRateLimits();
      expect(await pending).toBeInstanceOf(ProcessCanceled);
      const response = Object.assign(new EventEmitter(), {
        statusCode: 200,
        headers: {
          "content-type": "application/json",
          "x-rl-hourly-remaining": "31",
          "x-rl-daily-remaining": "71",
        },
        setEncoding: vi.fn(),
        resume: vi.fn(),
      });
      expect(() => respond(response)).not.toThrow();
      response.emit("data", JSON.stringify({ mod_id: 1 }));
      expect(() => response.emit("end")).not.toThrow();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(instances[0].getRateLimits()).toEqual({ daily: 71, hourly: 31 });
      expect(nexus.getRateLimits()).toEqual(currentLimits);
    } finally {
      get.mockRestore();
    }
  });
});

describe("final SDK transport serialization", () => {
  test("a token-await continuation cannot send a retired HTTP request", async ({ makeApi }) => {
    const harness = makeApi();
    const access = account(harness, 1);
    const get = vi
      .spyOn(https, "get")
      .mockImplementation(() => new EventEmitter() as ReturnType<typeof https.get>);
    const make = () => {
      const sdk = new Nexus("Inert unit fixture", "1.0.0", "fixture", 30000);
      Object.assign(sdk, { mQuota: { wait: () => Promise.resolve(), finishInit: vi.fn() } });
      return sdk;
    };
    try {
      const nexus = createAccountClient(harness.api, make, requestFuncs);
      let reads = 0;
      await nexus.setTokenProvider(() => {
        reads += 1;
        return Promise.resolve(access).then((value) => {
          if (reads > 1) queueMicrotask(() => account(harness, 2));
          return value;
        });
      });
      const pending = nexus.getModInfo(1, "fixture").catch((error) => error);
      expect(await pending).toBeInstanceOf(ProcessCanceled);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(reads).toBe(2);
      expect(get).not.toHaveBeenCalled();
    } finally {
      get.mockRestore();
    }
  });

  test.for([false, true])(
    "feedback blocked on file inspection cannot upload after account replacement (anonymous=%s)",
    async (anonymous, { makeApi }) => {
      const harness = makeApi();
      account(harness, 1);
      const inspected = deferred<void>(),
        entered = deferred<void>();
      const request = vi.spyOn(https, "request").mockImplementation(
        () =>
          new Writable({
            write(_chunk, _encoding, done) {
              done();
            },
          }) as ReturnType<typeof https.request>,
      );
      const make = () => {
        const sdk = new Nexus("Inert unit fixture", "1.0.0", "fixture", 30000);
        Object.assign(sdk, {
          mQuota: { wait: () => Promise.resolve() },
          checkFileSize: () => {
            entered.resolve(undefined);
            return inspected.promise;
          },
        });
        return sdk;
      };
      try {
        const nexus = createAccountClient(harness.api, make, requestFuncs);
        const pending = nexus
          .sendFeedback("Inert test", "Do not send", undefined!, anonymous)
          .catch((error) => error);
        await entered.promise;
        account(harness, 2);
        expect(await pending).toBeInstanceOf(ProcessCanceled);
        inspected.resolve(undefined);
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(request).not.toHaveBeenCalled();
      } finally {
        inspected.resolve(undefined);
        request.mockRestore();
      }
    },
  );
});

describe("current feedback transport controls", () => {
  test.for([false, true])(
    "current feedback succeeds with its intended authentication (anonymous=%s)",
    async (anonymous, { makeApi }) => {
      const harness = makeApi();
      account(harness, 1);
      const request = vi.spyOn(https, "request").mockImplementation(((
        _options: unknown,
        callback: (response: unknown) => void,
      ) => {
        queueMicrotask(() => {
          const response = Object.assign(new EventEmitter(), {
            statusCode: 200,
            setEncoding: vi.fn(),
          });
          callback(response);
          response.emit("data", JSON.stringify({ success: true }));
          response.emit("end");
        });
        return new Writable({
          write(_chunk, _encoding, done) {
            done();
          },
        });
      }) as typeof https.request);
      const make = () => {
        const sdk = new Nexus("Inert unit fixture", "1.0.0", "fixture", 30000);
        Object.assign(sdk, { mQuota: { wait: () => Promise.resolve() } });
        return sdk;
      };
      try {
        const nexus = createAccountClient(harness.api, make, requestFuncs);
        const current = account(harness, 2);
        await expect(
          nexus.sendFeedback("Inert test", "Do not send", undefined!, anonymous),
        ).resolves.toEqual({ success: true });
        expect(request).toHaveBeenCalledOnce();
        const options = request.mock.calls[0][0] as unknown as { headers: Record<string, unknown> };
        expect(options.headers.Authorization).toBe(anonymous ? undefined : `Bearer ${current}`);
      } finally {
        request.mockRestore();
      }
    },
  );
});

describe("feedback attachment ownership", () => {
  test("retired file-inspection continuation cannot allocate an attachment stream", async ({
    makeApi,
  }) => {
    const harness = makeApi();
    account(harness, 1);
    const inspected = deferred<void>(),
      entered = deferred<void>();
    const streams: PassThrough[] = [];
    const createReadStream = vi.spyOn(fs, "createReadStream").mockImplementation(() => {
      const stream = new PassThrough();
      streams.push(stream);
      return stream as unknown as ReturnType<typeof fs.createReadStream>;
    });
    const request = vi.spyOn(https, "request").mockImplementation(
      () =>
        new Writable({
          write(_chunk, _encoding, done) {
            done();
          },
        }) as ReturnType<typeof https.request>,
    );
    const make = () => {
      const sdk = new Nexus("Inert unit fixture", "1.0.0", "fixture", 30000);
      Object.assign(sdk, {
        mQuota: { wait: () => Promise.resolve() },
        checkFileSize: () => {
          entered.resolve(undefined);
          return inspected.promise;
        },
      });
      return sdk;
    };
    try {
      const nexus = createAccountClient(harness.api, make, requestFuncs);
      const pending = nexus
        .sendFeedback("Inert test", "Do not send", "inert-unit-attachment.zip", false)
        .catch((error) => error);
      await entered.promise;
      account(harness, 2);
      expect(await pending).toBeInstanceOf(ProcessCanceled);
      inspected.resolve(undefined);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(createReadStream).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
    } finally {
      inspected.resolve(undefined);
      streams.forEach((stream) => stream.destroy());
      createReadStream.mockRestore();
      request.mockRestore();
    }
  });
});
