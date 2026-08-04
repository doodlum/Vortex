import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, describe, expect, it } from "vitest";

import { CaseInsensitiveWritePath, resolveCasePath } from "./casePath";

describe.runIf(process.platform !== "win32")("CaseInsensitiveWritePath", () => {
  const temporary: string[] = [];

  afterEach(() => temporary.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true })));

  it("uses the spelling already present in the destination", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vortex-case-path-"));
    temporary.push(root);
    fs.mkdirSync(path.join(root, "Data", "SKSE"), { recursive: true });

    const resolver = new CaseInsensitiveWritePath(root);
    expect(resolver.resolve("data/skse/plugins/example.dll")).toBe(
      path.join("Data", "SKSE", "plugins", "example.dll"),
    );
  });

  it("makes planned paths collide before directories exist", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vortex-case-path-"));
    temporary.push(root);
    const resolver = new CaseInsensitiveWritePath(root);

    expect(resolver.resolve("Mods/Textures/Example.dds")).toBe(
      path.join("Mods", "Textures", "Example.dds"),
    );
    expect(resolver.resolve("mods/textures/example.dds")).toBe(
      path.join("Mods", "Textures", "Example.dds"),
    );
  });
});

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
