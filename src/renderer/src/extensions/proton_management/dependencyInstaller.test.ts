import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { ProcessCanceled } from "@vortex/shared/errors";
import PromiseBB from "bluebird";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { IExtensionApi } from "@/types/IExtensionContext";

import {
  DEPENDENCY_COMMAND_PYTHON,
  installDependencies,
  RECIPE_TIMEOUT_MS,
} from "./dependencyInstaller";

const TARGET = {
  steamPath: "/Steam",
  gamePath: "/Steam/steamapps/common/Game",
  protonPath: "/Steam/steamapps/common/Proton",
  compatDataPath: "/Steam/steamapps/compatdata/22380",
  protonName: "Proton 11.0",
  customToolRoots: [],
  readOnlyRoots: ["/Steam", "/External library"],
  runtimeWritePaths: ["/Runtime/var", "/Runtime/platform/files/.ref"],
};
function expectedRun(appId: string, recipes: string[]) {
  return [
    "run",
    "--user",
    "--die-with-parent",
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
    "--env=STEAM_EXTRA_COMPAT_TOOLS_PATHS=",
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
  it.each([false, true])(
    "forwards external custom registry roots into the helper, Flatpak host=%s",
    async (flatpak) => {
      process.env.IS_FLATPAK = String(flatpak);
      const runExecutable = vi.fn<IExtensionApi["runExecutable"]>(() => PromiseBB.resolve());
      const target = {
        ...TARGET,
        customToolRoots: ["/External registry", "/Second registry"],
        readOnlyRoots: [...TARGET.readOnlyRoots, "/External registry", "/Second registry"],
      };
      await installDependencies(
        { runExecutable } as unknown as IExtensionApi,
        "22380",
        ["xact"],
        undefined,
        { target },
      );
      expect(runExecutable.mock.calls.at(-1)?.[1]).toContain(
        "--env=STEAM_EXTRA_COMPAT_TOOLS_PATHS=/External registry:/Second registry",
      );
    },
  );

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
    ).rejects.toThrow("Flathub remote");
    expect(runExecutable).toHaveBeenCalledWith(
      "flatpak",
      ["info", "--user", "com.github.Matoking.protontricks"],
      expect.objectContaining({ cwd: "/", expectSuccess: true, shell: false }),
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
      ["--host", "--watch-bus", "flatpak", ...expectedRun("2050650", ["vcrun2022", "xinput"])],
      expect.objectContaining({ cwd: "/", expectSuccess: true, shell: false }),
    );
  });

  it("provisions Protontricks when it is not installed", async () => {
    process.env.IS_FLATPAK = "true";
    const runExecutable = vi
      .fn()
      .mockReturnValueOnce(PromiseBB.reject(new Error("not installed")))
      .mockReturnValueOnce(PromiseBB.reject(new Error("not installed")))
      .mockReturnValue(PromiseBB.resolve());
    const api = { runExecutable } as unknown as IExtensionApi;

    await installDependencies(api, "2050650", ["vcrun2022"], undefined, { target: TARGET });

    expect(runExecutable.mock.calls[1][1]).toEqual([
      "--host",
      "--watch-bus",
      "flatpak",
      "info",
      "--system",
      "com.github.Matoking.protontricks",
    ]);
    expect(runExecutable.mock.calls[2][1]).toEqual([
      "--host",
      "--watch-bus",
      "flatpak",
      "install",
      "--user",
      "--noninteractive",
      "-y",
      "flathub",
      "com.github.Matoking.protontricks",
    ]);
    expect(runExecutable.mock.calls[3][1]).toEqual([
      "--host",
      "--watch-bus",
      "flatpak",
      "update",
      "--user",
      "--noninteractive",
      "-y",
      "com.github.Matoking.protontricks",
    ]);
  });

  it("uses a system-wide Protontricks when Flathub is only a system remote", async () => {
    delete process.env.IS_FLATPAK;
    const runExecutable = vi.fn((_command: string, args: string[]) =>
      args[0] === "info" || (args[0] === "install" && args[1] === "--user")
        ? PromiseBB.reject(new Error("No remote refs found for 'flathub'"))
        : PromiseBB.resolve(),
    );
    await installDependencies(
      { runExecutable } as unknown as IExtensionApi,
      "22380",
      ["xact"],
      undefined,
      { target: TARGET },
    );
    const calls = runExecutable.mock.calls.map((call) => call[1].slice(0, 2));
    expect(calls).toEqual([
      ["info", "--user"],
      ["info", "--system"],
      ["install", "--user"],
      ["install", "--system"],
      ["update", "--system"],
      ["run", "--system"],
    ]);
  });

  it("ends a recipe run that stops responding instead of waiting forever", async () => {
    delete process.env.IS_FLATPAK;
    vi.useFakeTimers();
    let ended: () => void = () => undefined;
    const kill = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (signal === "SIGKILL") ended();
      return true;
    });
    try {
      const runExecutable = vi.fn(
        (_command: string, args: string[], options: { onSpawned?: (pid?: number) => void }) => {
          if (args[0] !== "run") return PromiseBB.resolve();
          options.onSpawned?.(4242);
          return new PromiseBB<void>((_resolve, reject) => {
            ended = () => reject(new Error("helper killed"));
          });
        },
      );
      const operation = installDependencies(
        { runExecutable } as unknown as IExtensionApi,
        "22380",
        ["xact"],
        undefined,
        { target: TARGET },
      );
      const outcome = expect(operation).rejects.toThrow("stopped responding");
      await vi.advanceTimersByTimeAsync(RECIPE_TIMEOUT_MS);
      expect(kill).toHaveBeenCalledWith(4242, "SIGTERM");
      await vi.advanceTimersByTimeAsync(10_000);
      await outcome;
      expect(kill).toHaveBeenCalledWith(4242, "SIGKILL");
    } finally {
      kill.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each(["resolve", "reject"] as const)(
    "cancels delayed termination after a timed-out helper exits (%s)",
    async (completion) => {
      delete process.env.IS_FLATPAK;
      vi.useFakeTimers();
      const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
      let finish: () => void = () => undefined;
      const waiting = new PromiseBB<void>((resolve, reject) => {
        finish = () => (completion === "resolve" ? resolve() : reject(new Error("helper exited")));
      });
      const runExecutable = vi.fn(
        (_command: string, args: string[], options: { onSpawned?: (pid?: number) => void }) => {
          if (args[0] !== "run") return PromiseBB.resolve();
          options.onSpawned?.(4242);
          return waiting;
        },
      );
      const outcome = installDependencies(
        { runExecutable } as unknown as IExtensionApi,
        "22380",
        ["xact"],
        undefined,
        { target: TARGET },
      ).catch((error: unknown) => error);
      try {
        await vi.advanceTimersByTimeAsync(RECIPE_TIMEOUT_MS);
        expect(kill).toHaveBeenCalledWith(4242, "SIGTERM");
        finish();
        await vi.advanceTimersByTimeAsync(0);
        expect(await outcome).toBeInstanceOf(Error);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(kill.mock.calls).toEqual([[4242, "SIGTERM"]]);
      } finally {
        finish();
        await vi.advanceTimersByTimeAsync(0);
        await outcome;
        kill.mockRestore();
        vi.useRealTimers();
      }
    },
  );

  it("keeps a timed-out helper ahead of the next same-game request until its exit", async () => {
    delete process.env.IS_FLATPAK;
    vi.useFakeTimers();
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    let finish: () => void = () => undefined;
    const waiting = new PromiseBB<void>((resolve) => {
      finish = resolve;
    });
    let runs = 0;
    const runExecutable = vi.fn(
      (_command: string, args: string[], options: { onSpawned?: (pid?: number) => void }) => {
        if (args[0] !== "run" || ++runs > 1) return PromiseBB.resolve();
        options.onSpawned?.(4242);
        return waiting;
      },
    );
    const api = { runExecutable } as unknown as IExtensionApi;
    const first = installDependencies(api, "22380", ["xact"], undefined, { target: TARGET }).catch(
      (error: unknown) => error,
    );
    const second = installDependencies(api, "22380", ["xinput"], undefined, { target: TARGET });
    try {
      await vi.advanceTimersByTimeAsync(RECIPE_TIMEOUT_MS);
      expect(kill).toHaveBeenCalledWith(4242, "SIGTERM");
      expect(runs).toBe(1);
      finish();
      await vi.advanceTimersByTimeAsync(0);
      expect(await first).toBeInstanceOf(Error);
      await second;
      expect(runs).toBe(2);
    } finally {
      finish();
      await vi.advanceTimersByTimeAsync(0);
      await Promise.allSettled([first, second]);
      kill.mockRestore();
      vi.useRealTimers();
    }
  });

  it("stops a helper whose spawn callback arrives after its deadline", async () => {
    delete process.env.IS_FLATPAK;
    vi.useFakeTimers();
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    let finish: () => void = () => undefined;
    let spawned: ((pid?: number) => void) | undefined;
    const waiting = new PromiseBB<void>((resolve) => {
      finish = resolve;
    });
    const runExecutable = vi.fn(
      (_command: string, args: string[], options: { onSpawned?: (pid?: number) => void }) => {
        if (args[0] !== "run") return PromiseBB.resolve();
        spawned = options.onSpawned;
        return waiting;
      },
    );
    const outcome = installDependencies(
      { runExecutable } as unknown as IExtensionApi,
      "22380",
      ["xact"],
      undefined,
      { target: TARGET },
    ).catch((error: unknown) => error);
    try {
      await vi.advanceTimersByTimeAsync(RECIPE_TIMEOUT_MS);
      expect(kill).not.toHaveBeenCalled();
      spawned?.(4242);
      expect(kill).toHaveBeenCalledWith(4242, "SIGTERM");
      finish();
      await vi.advanceTimersByTimeAsync(0);
      expect(await outcome).toBeInstanceOf(Error);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(kill.mock.calls).toEqual([[4242, "SIGTERM"]]);
    } finally {
      finish();
      await vi.advanceTimersByTimeAsync(0);
      await outcome;
      kill.mockRestore();
      vi.useRealTimers();
    }
  });

  it.runIf(process.platform === "linux")(
    "waits for an actual unresponsive helper to close before the next recipe starts",
    async () => {
      delete process.env.IS_FLATPAK;
      vi.useFakeTimers();
      let child: ReturnType<typeof spawn> | undefined;
      let closed: Promise<void> | undefined;
      let exited = false;
      let starts = 0;
      let ready: () => void = () => undefined;
      let sawTerm: () => void = () => undefined;
      const started = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const terminated = new Promise<void>((resolve) => {
        sawTerm = resolve;
      });
      const runExecutable = vi.fn(
        (
          _command: string,
          args: string[],
          options: {
            onSpawned?: (pid?: number) => void;
            onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
          },
        ) => {
          if (args[0] !== "run") return PromiseBB.resolve();
          starts++;
          if (starts > 1) {
            expect(exited).toBe(true);
            return PromiseBB.resolve();
          }
          child = spawn(
            process.execPath,
            [
              "-e",
              'process.on("SIGTERM", () => process.send("term")); process.send("ready"); setInterval(() => {}, 1000);',
            ],
            { stdio: ["ignore", "ignore", "ignore", "ipc"] },
          );
          const active = child;
          options.onSpawned?.(active.pid);
          active.on("message", (message) => {
            if (message === "ready") ready();
            if (message === "term") sawTerm();
          });
          closed = new Promise<void>((resolve) => active.once("close", () => resolve()));
          return new PromiseBB<void>((_resolve, reject) => {
            active.once("error", reject);
            active.once("close", (code, signal) => {
              exited = true;
              options.onExit?.(code, signal);
              reject(new Error("owned helper closed"));
            });
          });
        },
      );
      const api = { runExecutable } as unknown as IExtensionApi;
      const first = installDependencies(api, "22380", ["xact"], undefined, {
        target: TARGET,
      }).catch((error: unknown) => error);
      let second: Promise<unknown> | undefined;
      try {
        await started;
        second = installDependencies(api, "22380", ["xinput"], undefined, { target: TARGET }).catch(
          (error: unknown) => error,
        );
        await vi.advanceTimersByTimeAsync(RECIPE_TIMEOUT_MS);
        await terminated;
        expect(starts).toBe(1);
        expect(exited).toBe(false);
        await vi.advanceTimersByTimeAsync(10_000);
        await closed;
        await vi.advanceTimersByTimeAsync(0);
        expect(await first).toBeInstanceOf(Error);
        expect(await second).toBeUndefined();
        expect(starts).toBe(2);
        expect(child?.signalCode).toBe("SIGKILL");
      } finally {
        if (child?.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await closed;
        await vi.advanceTimersByTimeAsync(0);
        await Promise.allSettled([first, second]);
        vi.useRealTimers();
      }
    },
  );
});
