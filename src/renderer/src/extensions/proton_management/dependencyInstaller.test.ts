import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { ProcessCanceled } from "@vortex/shared/errors";
import PromiseBB from "bluebird";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { IExtensionApi } from "@/types/IExtensionContext";

import { DEPENDENCY_COMMAND_PYTHON, installDependencies } from "./dependencyInstaller";

const TARGET = {
  steamPath: "/Steam",
  gamePath: "/Steam/steamapps/common/Game",
  protonPath: "/Steam/steamapps/common/Proton",
  compatDataPath: "/Steam/steamapps/compatdata/22380",
  protonName: "Proton 11.0",
  readOnlyRoots: ["/Steam", "/External library"],
  runtimeWritePaths: ["/Runtime/var", "/Runtime/platform/files/.ref"],
};
function expectedRun(appId: string, recipes: string[]) {
  return [
    "run",
    "--user",
    "--unset-env=WINE",
    "--unset-env=WINESERVER",
    "--unset-env=WINETRICKS",
    "--unset-env=STEAM_RUNTIME",
    "--filesystem=/Steam:ro",
    "--filesystem=/External library:ro",
    "--filesystem=/Runtime/var:rw",
    "--filesystem=/Runtime/platform/files/.ref:rw",
    `--filesystem=${TARGET.compatDataPath}:rw`,
    "--env=STEAM_DIR=/Steam",
    `--env=STEAM_COMPAT_DATA_PATH=${TARGET.compatDataPath}`,
    "--env=PROTON_VERSION=Proton 11.0",
    `--env=VORTEX_DEPENDENCY_TARGET=${JSON.stringify(TARGET)}`,
    `--env=VORTEX_DEPENDENCY_RECIPES=${JSON.stringify(["-q", ...recipes])}`,
    "com.github.Matoking.protontricks",
    "-c",
    `python3 -c '${DEPENDENCY_COMMAND_PYTHON.replaceAll("'", "'\\''")}'`,
    appId,
  ];
}
const originalFlatpak = process.env.IS_FLATPAK;

afterEach(() => {
  if (originalFlatpak === undefined) delete process.env.IS_FLATPAK;
  else process.env.IS_FLATPAK = originalFlatpak;
});

describe("Proton dependency installer", () => {
  it.runIf(process.platform === "linux")(
    "checks the final sandbox environment before executing any recipe",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "vortex-dependency-command-"));
      try {
        const target = {
          ...TARGET,
          protonPath: path.join(root, "Proton"),
          runtimePath: path.join(root, "Runtime"),
          gamePath: path.join(root, "Game"),
          compatDataPath: path.join(root, "compatdata"),
        };
        for (const directory of [
          target.protonPath,
          target.runtimePath,
          target.gamePath,
          path.join(target.compatDataPath, "pfx"),
          path.join(root, "wrong"),
        ])
          await fs.mkdir(directory, { recursive: true });
        const receipt = path.join(root, "receipt.json");
        await fs.writeFile(
          path.join(root, "winetricks"),
          '#!/usr/bin/env python3\nimport json, os, sys\nwith open(os.environ["RECEIPT"], "w") as output: json.dump(sys.argv[1:], output)\n',
          { mode: 0o700 },
        );
        const environment = {
          ...process.env,
          PATH: `${root}:${process.env.PATH}`,
          RECEIPT: receipt,
          WINETRICKS: path.join(root, "winetricks"),
          VORTEX_DEPENDENCY_TARGET: JSON.stringify(target),
          VORTEX_DEPENDENCY_RECIPES: JSON.stringify(["--force", "xact", "literal $(unused)"]),
          PROTON_PATH: target.protonPath,
          STEAM_RUNTIME_PATH: target.runtimePath,
          STEAM_APP_PATH: target.gamePath,
          WINEPREFIX: path.join(target.compatDataPath, "pfx"),
        };
        for (const key of ["PROTON_PATH", "STEAM_APP_PATH", "WINEPREFIX", "STEAM_RUNTIME_PATH"]) {
          const result = spawnSync("python3", ["-c", DEPENDENCY_COMMAND_PYTHON], {
            env: { ...environment, [key]: path.join(root, "wrong") },
            encoding: "utf8",
          });
          expect(result.status, result.stderr).not.toBe(0);
          await expect(fs.stat(receipt)).rejects.toMatchObject({ code: "ENOENT" });
        }
        const result = spawnSync("python3", ["-c", DEPENDENCY_COMMAND_PYTHON], {
          env: environment,
          encoding: "utf8",
        });
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(await fs.readFile(receipt, "utf8"))).toEqual([
          "--force",
          "xact",
          "literal $(unused)",
        ]);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it("rechecks a queued manual request before starting any of its commands", async () => {
    let complete: () => void;
    const waiting = new PromiseBB<void>((resolve) => {
      complete = resolve;
    });
    const runExecutable = vi
      .fn<IExtensionApi["runExecutable"]>()
      .mockReturnValueOnce(waiting)
      .mockReturnValue(PromiseBB.resolve());
    const api = { runExecutable } as unknown as IExtensionApi;
    const first = installDependencies(api, "22380", ["xact"], undefined, { target: TARGET });
    await vi.waitFor(() => expect(runExecutable).toHaveBeenCalledOnce());
    let current = true;
    const second = installDependencies(api, "22380", ["xinput"], undefined, {
      target: TARGET,
      assertCurrent: () => {
        if (!current) throw new ProcessCanceled("queued profile changed");
      },
    });
    current = false;
    complete();
    const results = await Promise.allSettled([first, second]);
    expect(results[0].status).toBe("fulfilled");
    expect(results[1]).toMatchObject({ status: "rejected", reason: expect.any(ProcessCanceled) });
    expect(runExecutable).toHaveBeenCalledTimes(3);
    expect(runExecutable.mock.calls.flatMap((call) => call[1] ?? [])).not.toContain("xinput");
  });
  it("forces recipe reapplication when repairing a changed prefix version", async () => {
    delete process.env.IS_FLATPAK;
    const runExecutable = vi.fn<IExtensionApi["runExecutable"]>(() => PromiseBB.resolve());
    await installDependencies(
      { runExecutable } as unknown as IExtensionApi,
      "22380",
      ["xact"],
      undefined,
      { force: true, target: TARGET },
    );
    expect(runExecutable.mock.calls.at(-1)?.[1]).toEqual(expectedRun("22380", ["--force", "xact"]));
  });

  it("stops later subprocesses after a profile change during a running command", async () => {
    let complete: () => void;
    const waiting = new PromiseBB<void>((resolve) => {
      complete = resolve;
    });
    let current = true;
    const runExecutable = vi
      .fn<IExtensionApi["runExecutable"]>()
      .mockReturnValueOnce(waiting)
      .mockReturnValue(PromiseBB.resolve());
    const operation = installDependencies(
      { runExecutable } as unknown as IExtensionApi,
      "22380",
      ["xact"],
      undefined,
      {
        target: TARGET,
        assertCurrent: () => {
          if (!current) throw new ProcessCanceled("profile changed");
        },
      },
    );
    await vi.waitFor(() => expect(runExecutable).toHaveBeenCalledOnce());
    current = false;
    complete();
    await expect(operation).rejects.toBeInstanceOf(ProcessCanceled);
    expect(runExecutable).toHaveBeenCalledOnce();
  });
  it("rejects invalid identities and recipes before executing, and does nothing for no requirements", async () => {
    const runExecutable = vi.fn();
    const api = { runExecutable } as unknown as IExtensionApi;
    await expect(installDependencies(api, "../22380", ["xact"])).rejects.toThrow("AppID");
    await expect(installDependencies(api, "22380", ["unknown"])).rejects.toThrow("recipe");
    await expect(installDependencies(api, "22380", ["xact"])).rejects.toThrow(
      "exact Steam installation",
    );
    await installDependencies(api, "22380", []);
    expect(runExecutable).not.toHaveBeenCalled();
  });

  it("uses literal host commands outside Flatpak and reports a failed prerequisite", async () => {
    delete process.env.IS_FLATPAK;
    const runExecutable = vi.fn<IExtensionApi["runExecutable"]>(() =>
      PromiseBB.reject(new Error("flatpak missing")),
    );
    const api = { runExecutable } as unknown as IExtensionApi;
    await expect(
      installDependencies(api, "22380", ["xact"], undefined, { target: TARGET }),
    ).rejects.toThrow("Flathub user remote");
    expect(runExecutable).toHaveBeenCalledWith(
      "flatpak",
      ["info", "--user", "com.github.Matoking.protontricks"],
      { cwd: "/", expectSuccess: true, shell: false },
    );
    runExecutable.mockImplementation(() => PromiseBB.resolve());
    await expect(
      installDependencies(api, "22380", ["xact", "xact"], undefined, { target: TARGET }),
    ).resolves.toBeUndefined();
    expect(runExecutable.mock.calls.at(-1)?.[1]).toEqual(expectedRun("22380", ["xact"]));
  });
  it("passes the exact Steam installation, runtime and prefix through the host portal", async () => {
    process.env.IS_FLATPAK = "true";
    const runExecutable = vi.fn(() => PromiseBB.resolve());
    const api = { runExecutable } as unknown as IExtensionApi;

    await installDependencies(api, "2050650", ["vcrun2022", "xinput"], undefined, {
      target: TARGET,
    });

    expect(runExecutable).toHaveBeenNthCalledWith(
      3,
      "flatpak-spawn",
      ["--host", "flatpak", ...expectedRun("2050650", ["vcrun2022", "xinput"])],
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

    await installDependencies(api, "2050650", ["vcrun2022"], undefined, { target: TARGET });

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
