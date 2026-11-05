import type Nexus from "@nexusmods/nexus-api";
import { afterEach, describe, expect, vi } from "vitest";

import { test } from "@/test-utils/harnessTest";
import { ProcessCanceled } from "@/util/CustomErrors";

import { REVALIDATION_FREQUENCY } from "../constants";
import { createApiRevalidation } from "./apiRevalidation";

describe("API-key revalidation account boundaries", () => {
  afterEach(() => vi.useRealTimers());
  function client() {
    return {
      getValidationResult: vi.fn().mockReturnValue({ user_id: 1 }),
      setKey: vi.fn().mockResolvedValue({ user_id: 2 }),
      revalidate: vi.fn().mockResolvedValue({ user_id: 1 }),
    };
  }
  test("a replacement key cannot inherit the previous validation cooldown", async ({ makeApi }) => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const harness = makeApi();
    vi.spyOn(harness.api.events, "emit");
    harness.setState((draft) => {
      draft.confidential.account = { nexus: { APIKey: "fixture-a" } };
    });
    const invoke = createApiRevalidation(harness.api),
      sdk = client(),
      request = vi.fn().mockReturnValue("result");
    expect(invoke(sdk as unknown as Nexus, request)).toBe("result");
    harness.setState((draft) => {
      draft.confidential.account = { nexus: { APIKey: "fixture-b" } };
    });
    await expect(invoke(sdk as unknown as Nexus, request)).resolves.toBe("result");
    expect(sdk.setKey).toHaveBeenCalledWith("fixture-b");
    expect(sdk.revalidate).not.toHaveBeenCalled();
  });
  test("late validation cannot emit login or invoke the replacement account's query", async ({
    makeApi,
  }) => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const harness = makeApi();
    vi.spyOn(harness.api.events, "emit");
    harness.setState((draft) => {
      draft.confidential.account = { nexus: { APIKey: "fixture-a" } };
    });
    const invoke = createApiRevalidation(harness.api),
      sdk = client(),
      request = vi.fn();
    let finish!: (value: { user_id: number }) => void;
    sdk.revalidate.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    vi.setSystemTime(1001 + REVALIDATION_FREQUENCY);
    const pending = Promise.resolve(invoke(sdk as unknown as Nexus, request)).catch(
      (error) => error,
    );
    harness.setState((draft) => {
      draft.confidential.account = { nexus: { APIKey: "fixture-b" } };
    });
    finish({ user_id: 1 });
    expect(await pending).toBeInstanceOf(ProcessCanceled);
    expect(harness.api.events.emit).not.toHaveBeenCalledWith("did-login", null);
    expect(request).not.toHaveBeenCalled();
  });
  test("a login listener replacing the account cancels the pending query", async ({ makeApi }) => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const harness = makeApi();
    vi.spyOn(harness.api.events, "emit");
    harness.setState((draft) => {
      draft.confidential.account = { nexus: { APIKey: "fixture-a" } };
    });
    const invoke = createApiRevalidation(harness.api),
      sdk = client(),
      request = vi.fn();
    harness.api.events.on("did-login", () => {
      harness.setState((draft) => {
        draft.confidential.account = { nexus: { APIKey: "fixture-b" } };
      });
    });
    vi.setSystemTime(1001 + REVALIDATION_FREQUENCY);
    await expect(invoke(sdk as unknown as Nexus, request)).rejects.toBeInstanceOf(ProcessCanceled);
    expect(request).not.toHaveBeenCalled();
  });
  test("same-account expired validation renews and invokes once", async ({ makeApi }) => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const harness = makeApi();
    vi.spyOn(harness.api.events, "emit");
    harness.setState((draft) => {
      draft.confidential.account = { nexus: { APIKey: "fixture-a" } };
    });
    const invoke = createApiRevalidation(harness.api),
      sdk = client(),
      request = vi.fn().mockReturnValue("ok");
    vi.setSystemTime(1001 + REVALIDATION_FREQUENCY);
    await expect(invoke(sdk as unknown as Nexus, request)).resolves.toBe("ok");
    expect(sdk.revalidate).toHaveBeenCalledOnce();
    expect(sdk.setKey).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledOnce();
    expect(harness.api.events.emit).toHaveBeenCalledWith("did-login", null);
  });
});
