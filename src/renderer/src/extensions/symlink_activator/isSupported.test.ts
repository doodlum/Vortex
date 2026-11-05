import * as nodeFs from "node:fs";
import * as path from "node:path";

import { expect, vi } from "vitest";

import { test } from "../../test-utils/deploymentTest";
import type * as utilFs from "../../util/fs";

const probe = vi.hoisted(() => ({
  phase: undefined as "permission" | "write" | "link" | undefined,
  code: undefined as string | undefined,
  calls: [] as string[],
}));

vi.mock("../../util/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof utilFs>();
  const failure = (phase: string) => {
    probe.calls.push(phase);
    if (probe.phase === phase) {
      throw Object.assign(new Error(`Inert ${phase} failure: ${probe.code}`), { code: probe.code });
    }
  };
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (String(args[0]).endsWith("__vortex_canary.tmp")) failure("write");
      return actual.writeFileSync(...args);
    },
    symlinkSync: (_source: string, destination: string) => {
      failure(destination.endsWith("__link_test") ? "permission" : "link");
      // The probe's decision is under test, without requiring Windows symlink privileges.
      nodeFs.writeFileSync(destination, "inert probe");
    },
  };
});

function stateFor(gameId: string, gamePath: string, stagingDir: string) {
  return {
    settings: {
      gameMode: { discovered: { [gameId]: { path: gamePath } } },
      mods: { installPath: { [gameId]: stagingDir } },
    },
  } as any;
}

const platforms = ["linux", "win32"] as const;

test.for(
  platforms.flatMap((platform) =>
    ["permission", "write", "link"].flatMap((phase) =>
      ["ENOSPC", "EDQUOT"].map((code) => ({ platform, phase, code })),
    ),
  ),
)(
  "$platform: reports $code at the $phase probe as capacity",
  ({ platform, phase, code }, { makeDeployment }) => {
    const gameId = "symlink-capacity-game";
    const h = makeDeployment({ method: "symlink", gameId, files: { "payload.txt": "mod" } });
    vi.stubGlobal("process", { ...process, platform });
    probe.phase = phase as typeof probe.phase;
    probe.code = code;
    probe.calls = [];
    try {
      const reason = h.method.isSupported(
        stateFor(gameId, path.dirname(h.gameDir), h.stagingDir),
        gameId,
        "",
      );
      expect(probe.calls).toContain(phase);
      expect(reason?.description((text: string) => text)).toBe(
        code === "EDQUOT" ? "Disk quota exceeded." : "Not enough disk space to deploy mods.",
      );
      expect(reason?.solution?.((text: string) => text)).toMatch(
        code === "EDQUOT" ? /quota/i : /free.*space/i,
      );
      expect(nodeFs.readdirSync(h.gameDir).filter((name) => name.includes("canary"))).toEqual([]);
    } finally {
      probe.phase = undefined;
      probe.code = undefined;
      vi.unstubAllGlobals();
    }
  },
);

test.for(
  platforms.flatMap((platform) =>
    ["EPERM", "EACCES", "EROFS", "EMFILE"].map((code) => ({ platform, code })),
  ),
)(
  "$platform: preserves $code from the user-data permission probe",
  ({ platform, code }, { makeDeployment }) => {
    const gameId = "symlink-permission-game";
    const h = makeDeployment({ method: "symlink", gameId, files: { "payload.txt": "mod" } });
    vi.stubGlobal("process", { ...process, platform });
    probe.phase = "permission";
    probe.code = code;
    try {
      const reason = h.method.isSupported(
        stateFor(gameId, path.dirname(h.gameDir), h.stagingDir),
        gameId,
        "",
      );
      expect(reason?.description((text: string) => text)).toBe(
        platform === "win32" && code === "EPERM"
          ? "Requires admin rights on windows."
          : `Inert permission failure: ${code}`,
      );
    } finally {
      probe.phase = undefined;
      probe.code = undefined;
      vi.unstubAllGlobals();
    }
  },
);

test.for(
  platforms.flatMap((platform) =>
    [undefined, "EMFILE", "EISDIR", "EOPNOTSUPP"].map((code) => ({ platform, code })),
  ),
)(
  "$platform: retains target-probe behavior for $code",
  ({ platform, code }, { makeDeployment }) => {
    const gameId = "symlink-support-game";
    const h = makeDeployment({ method: "symlink", gameId, files: { "payload.txt": "mod" } });
    vi.stubGlobal("process", { ...process, platform });
    probe.phase = code === undefined ? undefined : "link";
    probe.code = code;
    try {
      const reason = h.method.isSupported(
        stateFor(gameId, path.dirname(h.gameDir), h.stagingDir),
        gameId,
        "",
      );
      if (code === undefined || code === "EMFILE") expect(reason).toBeUndefined();
      else
        expect(reason?.description((text: string) => text)).toMatch(
          /doesn't support symbolic links/,
        );
      expect(nodeFs.readdirSync(h.gameDir).filter((name) => name.includes("canary"))).toEqual([]);
    } finally {
      probe.phase = undefined;
      probe.code = undefined;
      vi.unstubAllGlobals();
    }
  },
);
