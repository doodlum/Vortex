import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runInNewContext } from "node:vm";

import { expect, it, vi } from "vitest";

import { MOUNT_HELPER_SOURCE } from "./mountHelper";

it.each(["packaged-relocation", "development-override", "changed-before-load"] as const)(
  "loads and identifies the actual requested addon (%s)",
  (mode) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vfs-helper-addon-"));
    const ownAddon = path.join(
      root,
      "resources",
      "app.asar.unpacked",
      "assets",
      "aether-vfs",
      "aether_vfs_node.node",
    );
    const override = path.join(root, "override.node");
    const requestedBytes = mode === "development-override" ? "development build" : "packaged build";
    const requestedHash = createHash("sha256").update(requestedBytes).digest("hex");
    const loaded: string[] = [];
    fs.mkdirSync(path.dirname(ownAddon), { recursive: true });
    fs.writeFileSync(
      ownAddon,
      mode === "changed-before-load" ? "changed package" : "packaged build",
    );
    if (mode !== "packaged-relocation")
      fs.writeFileSync(
        override,
        mode === "changed-before-load" ? "changed override" : requestedBytes,
      );
    fs.writeFileSync(
      path.join(root, "spec.json"),
      JSON.stringify({
        addon: override,
        addonHash: requestedHash,
        roots: [{ location: path.join(root, "game"), files: [] }],
        stateDir: path.join(root, "state"),
        generation: 1,
        version: "1.0.0",
        runtime: "requested-runtime",
      }),
    );
    const addon = {
      Session: class {
        start() {}
        close() {}
      },
    };
    try {
      runInNewContext(MOUNT_HELPER_SOURCE, {
        require: (name: string) => {
          if (name === "fs") return { ...fs, watch: vi.fn() };
          if (name === "path") return path;
          if (name === "crypto") return { createHash };
          loaded.push(name);
          return addon;
        },
        process: {
          argv: ["vortex", "helper.cjs", root],
          execPath: path.join(root, "vortex"),
          pid: 1,
          on: vi.fn(),
          exit: vi.fn(),
        },
        setInterval: vi.fn(),
        setTimeout: vi.fn(),
        clearTimeout: vi.fn(),
      });
      const status = JSON.parse(fs.readFileSync(path.join(root, "status.json"), "utf8"));
      if (mode === "changed-before-load") {
        expect(loaded).toEqual([]);
        expect(status).toMatchObject({
          mounted: false,
          error: expect.stringContaining("addon changed"),
        });
      } else {
        expect(loaded).toEqual([mode === "packaged-relocation" ? ownAddon : override]);
        expect(status).toMatchObject({
          mounted: true,
          runtime: "requested-runtime",
          version: "1.0.0",
        });
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
