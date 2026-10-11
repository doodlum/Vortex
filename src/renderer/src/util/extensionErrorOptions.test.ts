import { describe, expect, it, vi } from "vitest";

import type { IAvailableExtension, IRegisteredExtension } from "../types/extensions";
import type { IErrorOptions } from "../types/IExtensionContext";
import type { IState } from "../types/IState";
import { COMPANY_ID } from "./constants";
import { extensionErrorOptions } from "./extensionErrorOptions";

const extension = (
  name: string,
  modId?: number,
  author = "Community author",
): IRegisteredExtension => ({
  name,
  namespace: name,
  path: "/extension/" + name,
  dynamic: true,
  initFunc: () => () => true,
  info: { name, author, description: "Test extension", version: "1.0.0", modId },
});
const remote = (name: string, modId: number): IAvailableExtension => ({
  name,
  modId,
  fileId: 1,
  author: "Community author",
  version: "1.0.0",
  timestamp: 1,
});
const state = (available: IAvailableExtension[]): IState =>
  ({ session: { extensions: { available } } }) as unknown as IState;

describe("extension error attribution used by deployment status", () => {
  it("keeps built-in, unknown and metadata-less errors on their original report policy", () => {
    const options: IErrorOptions = { allowReport: true, hideDetails: true };
    const loaded = vi.fn(() => []);
    const builtin = extension("Official", undefined, COMPANY_ID);
    const noInfo = { ...extension("Without info"), info: undefined };
    for (const caller of [builtin, noInfo, undefined]) {
      expect(extensionErrorOptions(caller, loaded, state([]), new Error("failed"), options)).toBe(
        options,
      );
      expect(options).toEqual({ allowReport: true, hideDetails: true });
    }
    expect(loaded).not.toHaveBeenCalled();
  });

  it("prefers the actual calling extension over a different name in the error", () => {
    const caller = extension("Caller", 42),
      match = remote("Renamed caller", 42);
    const loaded = vi.fn(() => [extension("Named", 99)]);
    const options: IErrorOptions = { hideDetails: true };
    const result = extensionErrorOptions(
      caller,
      loaded,
      state([remote("Caller", 99), match]),
      { extension: "Named" },
      options,
    );
    expect(result).toBe(options);
    expect(result).toEqual({
      hideDetails: true,
      extensionName: "Caller",
      extensionRemote: match,
      extension: caller,
    });
    expect(loaded).not.toHaveBeenCalled();
  });

  it("routes an error from a named community extension to its matching remote metadata", () => {
    const named = extension("Named"),
      match = remote("Named", 42),
      loaded = vi.fn(() => [named]);
    expect(
      extensionErrorOptions(undefined, loaded, state([remote("Other", 42), match]), {
        extension: "Named",
      }),
    ).toEqual({
      extensionName: "Named",
      extensionRemote: match,
      extension: named,
    });
    expect(loaded).toHaveBeenCalledOnce();
  });

  it("does not grant reporting when the error explicitly disallows it", () => {
    const caller = extension("Caller", 42),
      options: IErrorOptions = { allowReport: false };
    expect(
      extensionErrorOptions(caller, () => [], state([remote("Caller", 42)]), "failed", options),
    ).toEqual({
      allowReport: false,
      extension: caller,
    });
    expect(options.extensionName).toBeUndefined();
    expect(options.extensionRemote).toBeUndefined();
  });

  it("keeps unknown named errors unchanged and does not substitute an unrelated extension", () => {
    const options: IErrorOptions = { allowReport: false },
      loaded = vi.fn(() => [extension("Other", 42)]);
    expect(
      extensionErrorOptions(
        undefined,
        loaded,
        state([remote("Other", 42)]),
        { extension: "Missing" },
        options,
      ),
    ).toBe(options);
    expect(options).toEqual({ allowReport: false });
  });
});
