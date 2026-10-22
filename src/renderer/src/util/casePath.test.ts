import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { describe, expect, it } from "vitest";

import { resolveCasePath } from "./casePath";

describe.runIf(process.platform !== "win32")("resolveCasePath", () => {
  it("resolves an extension-provided executable with Windows-style casing", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vortex-game-path-"));
    fs.mkdirSync(path.join(root, "Game"));
    fs.writeFileSync(path.join(root, "Game", "DarkSoulsII.exe"), "");

    try {
      expect(resolveCasePath(root, path.join("Game", "DarksoulsII.exe"))).toBe(
        path.join(root, "Game", "DarkSoulsII.exe"),
      );
    } finally {
      fs.rmSync(root, { recursive: true });
    }
  });
});
