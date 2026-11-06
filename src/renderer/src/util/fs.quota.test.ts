import type * as nodeOs from "node:os";

import PromiseBB from "bluebird";
import { afterEach, describe, expect, it, vi } from "vitest";

import { genFSWrapperAsync } from "./fs";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof nodeOs>();
  const constants = { ...actual.constants, errno: { ...actual.constants.errno, EDQUOT: 122 } };
  return { ...actual, default: { ...actual, constants }, constants };
});

afterEach(() => vi.unstubAllGlobals());

describe("filesystem quota error diagnostics", () => {
  it.each(["UNKNOWN", "Unknown system error -122"])(
    "identifies Linux quota exhaustion reported as %s",
    async (code) => {
      vi.stubGlobal("process", { ...process, platform: "linux" });
      const showMessageBox = vi.fn().mockResolvedValue({ response: 0 });
      vi.stubGlobal("window", { api: { dialog: { showMessageBox } } });
      const error = Object.assign(new Error(`${code}: unknown error, write`), {
        code,
        errno: -122,
        syscall: "write",
        path: "/owned-test/manifest.tmp",
      });
      const operation = vi.fn(() => PromiseBB.reject(error));
      await expect(genFSWrapperAsync(operation)()).rejects.toMatchObject({
        code: "EDQUOT",
        errno: -122,
        syscall: "write",
        path: "/owned-test/manifest.tmp",
        message: expect.stringMatching(/quota exceeded/i),
      });
      expect(operation).toHaveBeenCalledTimes(1);
      expect(showMessageBox).not.toHaveBeenCalled();
    },
  );

  it.each([
    { platform: "win32", code: "Unknown system error -122", errno: -122 },
    { platform: "linux", code: "Unknown system error -123", errno: -123 },
    { platform: "linux", code: "EACCES", errno: -122 },
    { platform: "linux", code: "EDQUOT", errno: -122 },
  ])("preserves $platform $code", async ({ platform, code, errno }) => {
    vi.stubGlobal("process", { ...process, platform });
    const error = Object.assign(new Error("original diagnostic"), { code, errno });
    await expect(genFSWrapperAsync(() => PromiseBB.reject(error))()).rejects.toBe(error);
    expect(error.code).toBe(code);
    expect(error.message).toBe("original diagnostic");
  });
});
