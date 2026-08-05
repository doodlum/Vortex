import PromiseBB from "bluebird";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { IExtensionApi } from "@/types/IExtensionContext";

import { installDependencies } from "./dependencyInstaller";

const originalFlatpak = process.env.IS_FLATPAK;

afterEach(() => {
  process.env.IS_FLATPAK = originalFlatpak;
});

describe("Proton dependency installer", () => {
  it("targets the Steam App ID through the host portal instead of a fixed prefix", async () => {
    process.env.IS_FLATPAK = "true";
    const runExecutable = vi.fn(() => PromiseBB.resolve());
    const api = { runExecutable } as unknown as IExtensionApi;

    await installDependencies(api, "2050650", ["vcrun2022", "xinput"]);

    expect(runExecutable).toHaveBeenNthCalledWith(
      3,
      "flatpak-spawn",
      [
        "--host",
        "flatpak",
        "run",
        "com.github.Matoking.protontricks",
        "2050650",
        "vcrun2022",
        "xinput",
      ],
      { cwd: "/", expectSuccess: true, shell: false },
    );
  });

  it("provisions Protontricks when it is not installed", async () => {
    process.env.IS_FLATPAK = "true";
    const runExecutable = vi
      .fn()
      .mockReturnValueOnce(PromiseBB.reject(new Error("not installed")))
      .mockReturnValue(PromiseBB.resolve());
    const api = { runExecutable } as unknown as IExtensionApi;

    await installDependencies(api, "2050650", ["vcrun2022"]);

    expect(runExecutable.mock.calls[1][1]).toEqual([
      "--host",
      "flatpak",
      "install",
      "--user",
      "--noninteractive",
      "-y",
      "flathub",
      "com.github.Matoking.protontricks",
    ]);
    expect(runExecutable.mock.calls[2][1]).toEqual([
      "--host",
      "flatpak",
      "update",
      "--user",
      "--noninteractive",
      "-y",
      "com.github.Matoking.protontricks",
    ]);
  });
});
