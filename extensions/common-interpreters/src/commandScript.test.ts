import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { commandScript } from "./commandScript";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vortex-command & args-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe.runIf(process.platform === "win32")("Windows command scripts", () => {
  for (const extension of [".cmd", ".bat"]) {
    for (const shell of [undefined, false, true]) {
      it(`reads quoted paths through the bundled ${extension} interpreter with shell=${shell}`, async () => {
        const script = path.join(dir, `Read & Output${extension}`);
        const input = path.join(dir, "Input & File.txt");
        const output = path.join(dir, `Output & File-${extension}-${shell}.txt`);
        fs.writeFileSync(script, '@echo off\r\ntype "%~1" > "%~2"\r\nexit\r\n');
        fs.writeFileSync(input, "command script bytes");
        const transformed = commandScript({
          executable: script,
          args: [`"${input}"`, `"${output}"`],
          options: { shell },
        });
        expect(transformed.options.shell).toBe(shell ?? true);
        const useShell = false;
        const child = spawn(
          useShell ? `"${transformed.executable}"` : transformed.executable,
          transformed.args,
          {
            cwd: dir,
            shell: useShell,
            windowsVerbatimArguments: true,
          },
        );
        let stderr = "";
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        // /K intentionally retains a console after script errors; clean up its exact test tree.
        const timeout = setTimeout(() => {
          if (child.pid !== undefined)
            spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
        }, 3000);
        try {
          const code = await new Promise<number | null>((resolve, reject) => {
            child.on("error", reject);
            child.on("close", resolve);
          });
          expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
          expect(fs.readFileSync(output, "utf8")).toBe("command script bytes");
        } finally {
          clearTimeout(timeout);
        }
      });
    }
  }
});
