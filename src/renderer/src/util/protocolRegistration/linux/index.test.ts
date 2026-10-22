import { beforeEach, expect, test, vi } from "vitest";
vi.mock("../../log", () => ({ log: vi.fn() }));
vi.mock("../electron", () => ({
  isDefaultProtocolClient: vi.fn(),
  setDefaultProtocolClient: vi.fn(),
}));
import { isDefaultProtocolClient, setDefaultProtocolClient } from "../electron";
import { registerLinuxProtocolHandler } from "./index";

beforeEach(() => vi.resetAllMocks());
test("disabled and unsupported routes never change desktop integration", async () => {
  expect(await registerLinuxProtocolHandler({ protocol: "nxm", setAsDefault: false })).toBe(false);
  expect(await registerLinuxProtocolHandler({ protocol: "other", setAsDefault: true })).toBe(false);
  expect(isDefaultProtocolClient).not.toHaveBeenCalled();
  expect(setDefaultProtocolClient).not.toHaveBeenCalled();
});
test("awaits the main-process confirmation before reporting a changed default", async () => {
  vi.mocked(isDefaultProtocolClient).mockResolvedValue(false);
  let confirm: (() => void) | undefined;
  vi.mocked(setDefaultProtocolClient).mockReturnValue(
    new Promise<void>((resolve) => {
      confirm = resolve;
    }),
  );
  let completed = false;
  const request = registerLinuxProtocolHandler({ protocol: "nxm", setAsDefault: true }).then(
    (result) => {
      completed = true;
      return result;
    },
  );
  await Promise.resolve();
  expect(completed).toBe(false);
  expect(setDefaultProtocolClient).toHaveBeenCalledWith("nxm", undefined);
  confirm!();
  expect(await request).toBe(true);
});
test("an existing default reports no change, while host errors reach the caller", async () => {
  vi.mocked(isDefaultProtocolClient).mockResolvedValue(true);
  vi.mocked(setDefaultProtocolClient).mockResolvedValue();
  expect(await registerLinuxProtocolHandler({ protocol: "nxm", setAsDefault: true })).toBe(false);
  vi.mocked(setDefaultProtocolClient).mockRejectedValue(new Error("desktop command failed"));
  await expect(
    registerLinuxProtocolHandler({ protocol: "nxm", setAsDefault: true }),
  ).rejects.toThrow("desktop command failed");
});
