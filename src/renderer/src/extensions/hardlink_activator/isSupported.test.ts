import * as nodeFs from "node:fs";
import * as path from "node:path";

import { expect, vi } from "vitest";

import { test } from "../../test-utils/deploymentTest";
import type * as utilFs from "../../util/fs";
import { getGame } from "../gamemode_management/util/getGame";

const link = vi.hoisted(() => ({
  calls: [] as Array<[string, string]>,
  error: undefined as string,
}));

vi.mock("../../util/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof utilFs>();
  return {
    ...actual,
    linkSync: (source: string, dest: string) => {
      link.calls.push([source, dest]);
      if (link.error !== undefined) {
        throw Object.assign(new Error(link.error), { code: link.error });
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
