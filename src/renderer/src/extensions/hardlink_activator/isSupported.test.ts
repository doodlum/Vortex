import * as nodeFs from "node:fs";
import type * as nodeOs from "node:os";
import * as path from "node:path";

import { expect, vi } from "vitest";

import { test } from "../../test-utils/deploymentTest";
import type * as utilFs from "../../util/fs";
import { getGame } from "../gamemode_management/util/getGame";

const link = vi.hoisted(() => ({
  calls: [] as Array<[string, string]>,
  error: undefined as string,
  writeError: undefined as string,
  errno: undefined as number | undefined,
}));

vi.mock("../../util/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof utilFs>();
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (link.writeError !== undefined && String(args[0]).endsWith("__vortex_canary.tmp")) {
        throw Object.assign(new Error(link.writeError), {
          code: link.writeError,
          errno: link.errno,
        });
      }
      return actual.writeFileSync(...args);
    },
    linkSync: (source: string, dest: string) => {
      link.calls.push([source, dest]);
      if (link.error !== undefined) {
        throw Object.assign(new Error(link.error), { code: link.error, errno: link.errno });
      }
      nodeFs.writeFileSync(dest, "");
    },
  };
});

function supportState(gamePath: string, stagingDir: string) {
  return {
    settings: {
      gameMode: { discovered: { skyrimse: { path: gamePath } } },
      mods: { installPath: { skyrimse: stagingDir } },
    },
  } as any;
}

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof nodeOs>();
  const constants = { ...actual.constants, errno: { ...actual.constants.errno, EDQUOT: 122 } };
  return { ...actual, default: { ...actual, constants }, constants };
});

test.for(["write", "link"] as const)(
  "recognizes raw Linux quota errno at canary %s",
  (operation, { makeDeployment }) => {
    const h = makeDeployment({ files: { "a.esp": "a" } });
    const gamePath = path.dirname(h.gameDir);
    nodeFs.mkdirSync(getGame("skyrimse").getModPaths(gamePath)[""], { recursive: true });
    vi.stubGlobal("process", { ...process, platform: "linux" });
    link.errno = -122;
    link.error = operation === "link" ? "UNKNOWN" : undefined;
    link.writeError = operation === "write" ? "UNKNOWN" : undefined;
    try {
      const reason = h.method.isSupported(supportState(gamePath, h.stagingDir), "skyrimse", "");
      expect(reason?.description((text: string) => text)).toBe("Disk quota exceeded.");
    } finally {
      link.error = undefined;
      link.writeError = undefined;
      link.errno = undefined;
      vi.unstubAllGlobals();
    }
  },
);

test.for(["linux", "win32"] as const)(
  "%s: the support probe links where deployment will, and a cross-mount link rejects hardlinks",
  async (platform, { makeDeployment }) => {
    const h = makeDeployment({ files: { "a.esp": "a" } });
    const gamePath = path.dirname(h.gameDir);
    const modPath = getGame("skyrimse").getModPaths(gamePath)[""];
    nodeFs.mkdirSync(modPath, { recursive: true });
    vi.stubGlobal("process", { ...process, platform });
    try {
      link.calls = [];
      link.error = undefined;
      expect(h.method.isSupported(supportState(gamePath, h.stagingDir), "skyrimse", "")).toBe(
        undefined,
      );
      const [source, dest] = link.calls[0];
      expect(path.dirname(source)).toBe(h.stagingDir);
      expect(path.dirname(dest)).toBe(platform === "win32" ? h.stagingDir : modPath);
      expect(nodeFs.readdirSync(modPath)).toEqual([]);

      link.error = "EXDEV";
      const reason = h.method.isSupported(supportState(gamePath, h.stagingDir), "skyrimse", "");
      expect(reason?.description((text: string) => text)).toBe(
        "Works only if mods are installed on the same drive as the game.",
      );
      expect(nodeFs.readdirSync(h.stagingDir).filter((name) => name.includes("canary"))).toEqual(
        [],
      );
    } finally {
      vi.unstubAllGlobals();
    }
  },
);

test.for(["linux", "win32"] as const)(
  "%s: a purged missing mod root remains deployable without recreating it during selection",
  async (platform, { makeDeployment }) => {
    const h = makeDeployment({ files: { "a.esp": "a" } });
    const gamePath = path.dirname(h.gameDir);
    nodeFs.rmdirSync(h.gameDir);
    vi.stubGlobal("process", { ...process, platform });
    try {
      link.calls = [];
      link.error = undefined;
      expect(
        h.method.isSupported(supportState(gamePath, h.stagingDir), "skyrimse", ""),
      ).toBeUndefined();
      expect(nodeFs.existsSync(h.gameDir)).toBe(false);
      expect(path.dirname(link.calls[0][1])).toBe(platform === "win32" ? h.stagingDir : gamePath);
      expect(nodeFs.readdirSync(gamePath)).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  },
);

test.for(
  ["linux", "win32"].flatMap((platform) =>
    ["write", "link"].flatMap((operation) =>
      ["ENOSPC", "EDQUOT"].map((code) => ({ platform, operation, code })),
    ),
  ),
)(
  "$platform: reports $code from the canary $operation as capacity, not link support",
  ({ platform, operation, code }, { makeDeployment }) => {
    const h = makeDeployment({ files: { "a.esp": "a" } });
    const gamePath = path.dirname(h.gameDir);
    nodeFs.mkdirSync(getGame("skyrimse").getModPaths(gamePath)[""], { recursive: true });
    vi.stubGlobal("process", { ...process, platform });
    try {
      link.error = operation === "link" ? code : undefined;
      link.writeError = operation === "write" ? code : undefined;
      const reason = h.method.isSupported(supportState(gamePath, h.stagingDir), "skyrimse", "");
      expect(reason?.description((text: string) => text)).toBe(
        code === "EDQUOT" ? "Disk quota exceeded." : "Not enough disk space to deploy mods.",
      );
      expect(reason?.solution?.((text: string) => text)).toMatch(
        code === "EDQUOT" ? /quota/i : /free.*space/i,
      );
      for (const directory of [h.stagingDir, getGame("skyrimse").getModPaths(gamePath)[""]]) {
        expect(nodeFs.readdirSync(directory).filter((name) => name.includes("canary"))).toEqual([]);
      }
    } finally {
      link.error = undefined;
      link.writeError = undefined;
      vi.unstubAllGlobals();
    }
  },
);

test.for(["EMFILE", "EOPNOTSUPP"])(
  "retains the existing %s support-probe behavior",
  (code, { makeDeployment }) => {
    const h = makeDeployment({ files: { "a.esp": "a" } });
    const gamePath = path.dirname(h.gameDir);
    nodeFs.mkdirSync(getGame("skyrimse").getModPaths(gamePath)[""], { recursive: true });
    link.error = code;
    try {
      const reason = h.method.isSupported(supportState(gamePath, h.stagingDir), "skyrimse", "");
      if (code === "EMFILE") expect(reason).toBeUndefined();
      else
        expect(reason?.description((text: string) => text)).toBe(
          "Filesystem doesn't support hard links.",
        );
    } finally {
      link.error = undefined;
    }
  },
);
