import { spawnSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { describe, expect, it } from "vitest";

import {
  disableDefaultToolRedirect,
  disableShaderCacheRedirect,
  ensureShaderCacheWrapper,
  configureShaderCache,
  checkShaderCacheWrapper,
} from "./steamShaderSettings";

describe("Steam shader-cache launch integration", () => {
  it.skipIf(process.platform === "win32")(
    "checks Flatpak launchers from a host-visible working directory",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "vortex-host-preflight-"));
      const originalPath = process.env.PATH;
      const originalFlatpak = process.env.IS_FLATPAK;
      const originalReceipt = process.env.VORTEX_PREFLIGHT_RECEIPT;
      try {
        const portal = path.join(root, "flatpak-spawn");
        const helper = path.join(root, "helper");
        const receipt = path.join(root, "checked");
        await fs.writeFile(
          portal,
          '#!/bin/sh\nif [ "$PWD" != / ]; then echo "host cannot resolve sandbox working directory" >&2; exit 23; fi\n[ "$1" = --host ] || exit 24\nshift\nexec "$@"\n',
          { mode: 0o755 },
        );
        await fs.writeFile(
          helper,
          '#!/bin/sh\n[ "$1" = --check ] || exit 25\nprintf "%s\\n" "$PWD" >> "$VORTEX_PREFLIGHT_RECEIPT"\n',
          { mode: 0o755 },
        );
        process.env.PATH = `${root}${path.delimiter}${originalPath ?? ""}`;
        process.env.IS_FLATPAK = "true";
        process.env.VORTEX_PREFLIGHT_RECEIPT = receipt;
        // The portal's host view cannot enter the caller's sandbox-only directory.
        const refused = spawnSync(portal, ["--host", helper, "--check", "22380"], {
          cwd: root,
          encoding: "utf8",
        });
        expect(refused.status).toBe(23);
        expect(refused.stderr).toContain("host cannot resolve sandbox working directory");
        await checkShaderCacheWrapper("22380", helper);
        const checks = (await fs.readFile(receipt, "utf8")).trim().split("\n");
        expect(checks).toHaveLength(2);
        expect(checks.filter((cwd) => cwd === "/")).toHaveLength(1);
      } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
        if (originalFlatpak === undefined) delete process.env.IS_FLATPAK;
        else process.env.IS_FLATPAK = originalFlatpak;
        if (originalReceipt === undefined) delete process.env.VORTEX_PREFLIGHT_RECEIPT;
        else process.env.VORTEX_PREFLIGHT_RECEIPT = originalReceipt;
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it("replaces hardlinked managed files without changing another file", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vortex-launcher-files-"));
    try {
      const sentinel = path.join(root, "sentinel");
      await fs.writeFile(sentinel, "preserved");
      const shader = path.join(root, "vortex-shader-cache-run");
      const settings = path.join(root, "shader-cache-settings", "22380.json");
      await fs.mkdir(path.dirname(settings));
      for (const target of [shader, settings]) await fs.link(sentinel, target);
      await ensureShaderCacheWrapper(shader);
      await configureShaderCache("22380", ["/Steam/shadercache"], shader, "/private");
      expect(await fs.readFile(sentinel, "utf8")).toBe("preserved");
      expect(await fs.readFile(shader, "utf8")).toContain("def main(arguments)");
      expect(JSON.parse(await fs.readFile(settings, "utf8"))).toEqual({
        privateRoot: "/private",
        sourceRoots: [path.join("/Steam/shadercache", "22380")],
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("removes the loader redirect an earlier build added, keeping the user's options", () => {
    const wrapper = "/home/user/wrapper's run";
    const original = "env FLAG=1 %command% --literal";
    const redirected =
      "env FLAG=1 '/home/user/wrapper'\\''s run' '/Game/loader'\\''s.exe' %command% --literal";
    expect(disableDefaultToolRedirect(redirected, wrapper)).toBe(original);
    expect(disableDefaultToolRedirect(original, wrapper)).toBe(original);
  });

  it("removes the cache redirect an earlier build added, keeping script-extender options", () => {
    const original = 'bash -c \'set -- "${@/FalloutNVLauncher/nvse_loader}"; "$@"\' -- %command%';
    const wrapper = "/home/user/.local/share/vortex/bin/vortex-shader-cache-run";
    const redirected = original.replace("%command%", `'${wrapper}' 22380 %command%`);

    expect(disableShaderCacheRedirect(redirected, "22380", wrapper)).toBe(original);
    expect(disableShaderCacheRedirect(original, "22380", wrapper)).toBe(original);
  });
});
