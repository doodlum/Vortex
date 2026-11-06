import { constants } from "node:os";
import type * as nodeOs from "node:os";

import { afterEach, expect, it, vi } from "vitest";

import { getFilesystemErrorCode } from "./filesystemError";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof nodeOs>();
  const constants = { ...actual.constants, errno: { ...actual.constants.errno, EDQUOT: 122 } };
  return { ...actual, default: { ...actual, constants }, constants };
});

afterEach(() => vi.unstubAllGlobals());

it.each(["UNKNOWN", "Unknown system error -122"])("recognizes raw Linux quota code %s", (code) => {
  vi.stubGlobal("process", { ...process, platform: "linux" });
  expect(constants.errno.EDQUOT).toBe(122);
  expect(process.platform).toBe("linux");
  const error = Object.assign(new Error("original"), { code, errno: -122 });
  expect(getFilesystemErrorCode(error)).toBe("EDQUOT");
  expect(error.code).toBe(code);
  expect(error.message).toBe("original");
});

it.each([
  { platform: "win32", code: "UNKNOWN", errno: -122 },
  { platform: "darwin", code: "UNKNOWN", errno: -122 },
  { platform: "linux", code: "UNKNOWN", errno: 122 },
  { platform: "linux", code: "UNKNOWN", errno: -123 },
  { platform: "linux", code: "EACCES", errno: -122 },
  { platform: "linux", code: "Unknown system error -123", errno: -122 },
  { platform: "linux", code: "EDQUOT", errno: -122 },
  { platform: "linux", code: "ENOSPC", errno: -28 },
])("preserves $platform $code with errno $errno", ({ platform, code, errno }) => {
  vi.stubGlobal("process", { ...process, platform });
  expect(getFilesystemErrorCode(Object.assign(new Error("original"), { code, errno }))).toBe(code);
});

it("does not infer a quota failure from a message or non-error value", () => {
  vi.stubGlobal("process", { ...process, platform: "linux" });
  expect(getFilesystemErrorCode({ code: "UNKNOWN", errno: -122 })).toBeNull();
  expect(
    getFilesystemErrorCode(Object.assign(new Error("quota exceeded"), { code: "UNKNOWN" })),
  ).toBe("UNKNOWN");
});
