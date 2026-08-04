import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { extensionFilesystem } from "./extensionFilesystem";

describe.runIf(process.platform === "linux")("extensionFilesystem", () => {
  const temporary: string[] = [];

  afterEach(() => {
    temporary.splice(0).forEach((entry) => fs.rmSync(entry, { force: true, recursive: true }));
  });

  it("reads paths using Windows-style case and separators", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vortex-extension-fs-"));
    temporary.push(root);
    fs.mkdirSync(path.join(root, "Data", "SKSE", "Plugins"), { recursive: true });
    fs.writeFileSync(path.join(root, "Data", "SKSE", "Plugins", "Example.dll"), "ok");

    const compat = extensionFilesystem(fs);
    expect(
      compat.readFileSync(path.join(root, "data", "skse", "plugins", "example.dll"), "utf8"),
    ).toBe("ok");
  });

  it("reuses existing directory spelling for writes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vortex-extension-fs-"));
    temporary.push(root);
    fs.mkdirSync(path.join(root, "Data", "SKSE"), { recursive: true });

    const compat = extensionFilesystem(fs);
    compat.mkdirSync(path.join(root, "data", "skse", "Plugins"), { recursive: true });

    expect(fs.existsSync(path.join(root, "Data", "SKSE", "Plugins"))).toBe(true);
    expect(fs.existsSync(path.join(root, "data"))).toBe(false);
  });
});
