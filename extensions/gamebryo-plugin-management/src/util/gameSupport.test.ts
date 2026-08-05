import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, describe, expect, it } from "vitest";

import {
  resolveCaseInsensitiveChild,
  resolveCaseInsensitivePath,
} from "./resolveCaseInsensitiveChild";

describe.runIf(process.platform !== "win32")("appDataPath", () => {
  const temporary: string[] = [];

  afterEach(() => {
    temporary.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true }));
  });

  it("uses the existing directory spelling without requiring a case alias", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vortex-localappdata-"));
    temporary.push(root);
    fs.mkdirSync(path.join(root, "FalloutNV"));
    expect(resolveCaseInsensitiveChild(root, "falloutnv")).toBe(path.join(root, "FalloutNV"));
    expect(fs.readdirSync(root)).toEqual(["FalloutNV"]);
  });

  it("resolves every component of a LOOT file requirement", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vortex-game-data-"));
    temporary.push(root);
    fs.mkdirSync(path.join(root, "SKSE", "Plugins"), { recursive: true });
    fs.writeFileSync(path.join(root, "SKSE", "Plugins", "CustomSkills.dll"), "test");

    expect(resolveCaseInsensitivePath(root, "skse/plugins/customskills.dll")).toBe(
      path.join(root, "SKSE", "Plugins", "CustomSkills.dll"),
    );
  });
});
