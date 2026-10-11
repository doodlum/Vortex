import { HTTPError, StalledError, TemporaryError, UserCanceled } from "@vortex/shared/errors";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ outdated: false, ignored: false }));
vi.mock("./errorHandling", () => ({
  didIgnoreError: () => state.ignored,
  isOutdated: () => state.outdated,
  recordErrorSpan: vi.fn(),
}));
vi.mock("./log", () => ({ log: vi.fn() }));

import type { IErrorOptions } from "../types/IExtensionContext";
import { recordErrorSpan } from "./errorHandling";
import { log } from "./log";
import { describeError, errorDialogActions } from "./message";

const error = (fields: Record<string, unknown> = {}) =>
  Object.assign(new Error("raw"), { stack: "supplied stack", ...fields });

beforeEach(() => {
  state.outdated = false;
  state.ignored = false;
  vi.clearAllMocks();
});

describe("silent and notification error descriptions", () => {
  const cases: Array<[string, () => unknown]> = [
    ["string", () => "plain text"],
    ["ordinary Error", () => error({ Reason: "failed" })],
    [
      "file permissions",
      () => error({ code: "EACCES", path: "/game/config.ini", syscall: "open" }),
    ],
    ["locked file", () => error({ code: "EPERM", filename: "/game/config.ini" })],
    ["native unknown", () => error({ code: "UNKNOWN", nativeCode: 5 })],
    [
      "nested Error",
      () => ({
        error: error({ code: "EACCES", path: "/game/config.ini" }),
        executable: "/game/tool.exe",
        message: "Context",
      }),
    ],
    ["array", () => [error({ Reason: "failed" })]],
    ["HTTP private fields", () => new HTTPError(500, "server", "https://example.test/archive")],
    [
      "readonly message",
      () =>
        Object.defineProperty(error({ code: "EACCES", path: "/game/config.ini" }), "message", {
          value: "raw",
          writable: false,
        }),
    ],
    [
      "nonenumerable code",
      () =>
        Object.defineProperty(error({ path: "/game/config.ini" }), "code", {
          value: "EACCES",
          writable: true,
          enumerable: false,
        }),
    ],
    ["frozen Error", () => Object.freeze(error({ code: "EACCES", path: "/game/config.ini" }))],
    [
      "nonextensible Error",
      () => Object.preventExtensions(error({ code: "EACCES", path: "/game/config.ini" })),
    ],
    ["DOMException", () => new DOMException("Denied", "NotFoundError")],
    ["stalled", () => new StalledError("test archive")],
    ["temporary", () => new TemporaryError("Wait")],
    ["canceled", () => new UserCanceled()],
    ["custom stack", () => ({ message: "custom", stack: "supplied stack", Code: 12 })],
  ];
  for (const [name, make] of cases) {
    it("preserves single-normalization content for " + name, () => {
      const details = make();
      const target = Array.isArray(details)
        ? details[0]
        : details !== null && typeof details === "object" && "error" in details
          ? details.error
          : details;
      const before = target instanceof Error ? Object.getOwnPropertyDescriptors(target) : undefined;
      const options: IErrorOptions = { replace: { mod: "fixture" }, hideDetails: false };
      const quiet = describeError("Failure", details, options, false);
      if (target instanceof Error) expect(Object.getOwnPropertyDescriptors(target)).toEqual(before);
      expect(log).not.toHaveBeenCalled();
      expect(recordErrorSpan).not.toHaveBeenCalled();
      const notified = describeError("Failure", details, options);
      expect(quiet).toEqual(notified);
      expect(log).toHaveBeenCalledOnce();
    });
  }

  it("records the original supplied Error once and opening actions records nothing more", () => {
    const details = error({ Reason: "failed" });
    const prepared = describeError("Failure", details);
    expect(recordErrorSpan).toHaveBeenCalledWith("Failure", details, {
      "error.isCommunityExtension": false,
    });
    expect(recordErrorSpan).toHaveBeenCalledOnce();
    expect(details.stack).toBe("supplied stack");
    expect(errorDialogActions(vi.fn(), prepared).map((a) => a.label)).toEqual(["Close"]);
    expect(recordErrorSpan).toHaveBeenCalledOnce();
  });

  for (const gate of ["outdated", "ignored"] as const) {
    it("suppresses reporting when " + gate, () => {
      state[gate] = true;
      const prepared = describeError("Failure", error(), {
        extensionName: "Third party",
        extensionRemote: { modId: 42 } as IErrorOptions["extensionRemote"],
      });
      expect(prepared.reportURL).toBeUndefined();
      expect(recordErrorSpan).not.toHaveBeenCalled();
    });
  }

  for (const format of ["isHTML", "isBBCode"] as const) {
    it("preserves " + format + " content and wrap options", () => {
      const content = describeError("Failure", "formatted", { [format]: true }, false).content;
      expect(content).toEqual({
        [format === "isHTML" ? "htmlText" : "bbcode"]: "formatted",
        options: { wrap: false },
      });
    });
  }
});
