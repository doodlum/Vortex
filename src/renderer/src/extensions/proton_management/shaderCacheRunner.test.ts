import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { promisify, stripVTControlCharacters } from "util";

import { expect, it } from "vitest";

import { SHADER_CACHE_SOURCE } from "./shaderCacheRunner";

it.runIf(process.platform === "linux")(
  "runs the bundled launcher against real disposable Linux caches and children",
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "vortex-shader-runner-"));
    const runner = path.join(directory, "vortex-shader-cache-run");
    try {
      await fs.writeFile(runner, SHADER_CACHE_SOURCE, { mode: 0o755 });
      const result = await promisify(execFile)(
        "python3",
        [path.join(__dirname, "shaderCacheRunner.fixture.py"), "-v"],
        {
          env: { ...process.env, VORTEX_SHADER_TEST_RUNNER: runner },
          timeout: 90_000,
        },
      );
      // Python 3.14 honors the parent Nx FORCE_COLOR even though output is piped.
      const report = stripVTControlCharacters(result.stderr);
      expect(report).toContain("Ran 23 tests");
      expect(report.trim()).toMatch(/OK$/);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
  100_000,
);
