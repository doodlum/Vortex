import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { expect, it } from "vitest";

import { packageRoot, testWorkspace, workspaceRoot } from "./testWorkspace";

const require = createRequire(import.meta.url);
const nxPackage = require.resolve("nx/package.json", { paths: [workspaceRoot] });
const nxBin = path.resolve(
  path.dirname(nxPackage),
  JSON.parse(fs.readFileSync(nxPackage, "utf8")).bin.nx,
);
const production = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));

function cacheFixture() {
  const fixture = testWorkspace();
  const json = (file: string, value: unknown) => fixture.write(file, JSON.stringify(value));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("NX_")),
  );
  Object.assign(env, {
    NX_DAEMON: "false",
    NX_INTERACTIVE: "false",
    NX_NO_CLOUD: "true",
    NX_NATIVE_FILE_CACHE_DIRECTORY: path.join(fixture.root, ".nx/native"),
  });
  function command(bin: string, args: string[]) {
    const result = spawnSync(bin, args, {
      cwd: fixture.root,
      env,
      encoding: "utf8",
      timeout: 45_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    return { code: result.status, log: result.stdout + result.stderr };
  }
  try {
    json("package.json", {
      name: "api-cache-fixture",
      private: true,
      devDependencies: { nx: JSON.parse(fs.readFileSync(nxPackage, "utf8")).version },
    });
    json("nx.json", {
      neverConnectToCloud: true,
      analytics: false,
      tui: { enabled: false },
      namedInputs: { default: ["{projectRoot}/project.json"] },
    });
    fixture.write(".gitignore", "node_modules/\n.nx/\npackages/vortex-api/lib/\n.invocations/\n");
    json("src/renderer/project.json", {
      name: "@vortex/renderer",
      targets: {
        "api:dts": {
          executor: "nx:run-commands",
          cache: true,
          inputs: ["{projectRoot}/seed.txt"],
          outputs: ["{workspaceRoot}/packages/vortex-api/lib/api.d.ts"],
          options: { command: "node fixture-runner.cjs emit" },
        },
      },
    });
    const targets = structuredClone(production.nx.targets);
    targets["api:report"] = {
      ...targets["api:report"],
      executor: "nx:run-commands",
      options: { command: "node fixture-runner.cjs report" },
    };
    targets.typecheck = {
      ...targets.typecheck,
      executor: "nx:run-commands",
      options: { command: "node fixture-runner.cjs typecheck" },
    };
    json("packages/vortex-api/project.json", {
      name: "@nexusmods/vortex-api",
      implicitDependencies: ["@vortex/renderer"],
      targets,
    });
    fixture.write("packages/vortex-api/api-extractor.json", "{}\n");
    json("packages/vortex-api/tsconfig.lib.json", {
      files: ["lib/api.d.ts"],
      compilerOptions: { noEmit: true, skipLibCheck: true, target: "ES2022", types: [] },
    });
    fixture.write("etc/vortex.api.md", "initial\n");
    fixture.write(
      "fixture-runner.cjs",
      `
const fs = require('node:fs');
const cp = require('node:child_process');
const mode = process.argv[2];
const declaration = 'packages/vortex-api/lib/api.d.ts';
fs.mkdirSync('.invocations', {recursive: true});
fs.appendFileSync('.invocations/' + mode, 'run\\n');
if (mode === 'emit') {
  fs.mkdirSync('packages/vortex-api/lib', {recursive: true});
  fs.copyFileSync('src/renderer/seed.txt', declaration);
} else if (mode === 'report') {
  fs.copyFileSync(declaration, 'etc/vortex.api.md');
  fs.writeFileSync('packages/vortex-api/lib/tsdoc-metadata.json', '{}\\n');
} else if (mode === 'typecheck') {
  const result = cp.spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'packages/vortex-api/tsconfig.lib.json'], {stdio: 'inherit'});
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} else throw new Error('Unexpected fixture mode: ' + mode);
`,
    );
    fixture.write("src/renderer/seed.txt", "export declare const apiValue: 'A';\n");
    for (const args of [
      ["init", "--quiet"],
      ["add", "--", "."],
    ]) {
      const result = command("git", args);
      expect(result.code, result.log).toBe(0);
    }
    return {
      ...fixture,
      seed(contents: string) {
        fixture.write("src/renderer/seed.txt", contents);
      },
      read(file: string) {
        return fs.readFileSync(path.join(fixture.root, file), "utf8");
      },
      count(mode: string) {
        return fs
          .readFileSync(path.join(fixture.root, ".invocations", mode), "utf8")
          .trim()
          .split("\n").length;
      },
      run(target: string) {
        return command(process.execPath, [
          nxBin,
          "run",
          "@nexusmods/vortex-api:" + target,
          "--outputStyle=static",
        ]);
      },
    };
  } catch (error) {
    fixture.dispose();
    throw error;
  }
}

it("invalidates API reports when the generated declaration changes and restores unchanged output from cache", () => {
  const fixture = cacheFixture();
  try {
    for (const value of ["A", "B", "C"]) {
      const declaration = `export declare const apiValue: '${value}';\n`;
      fixture.seed(declaration);
      const result = fixture.run("api:report");
      expect(result.code, result.log).toBe(0);
      expect(fixture.read("packages/vortex-api/lib/api.d.ts")).toBe(declaration);
      expect(fixture.read("etc/vortex.api.md"), result.log).toBe(declaration);
    }
    expect(fixture.count("report")).toBe(3);
    fs.unlinkSync(path.join(fixture.root, "etc/vortex.api.md"));
    const cached = fixture.run("api:report");
    expect(cached.code, cached.log).toBe(0);
    expect(fixture.read("etc/vortex.api.md")).toContain("'C'");
    expect(fixture.count("report")).toBe(3);
  } finally {
    fixture.dispose();
  }
}, 120_000);

it("reruns API typechecking for an invalid generated declaration instead of replaying a cached success", () => {
  const fixture = cacheFixture();
  try {
    const first = fixture.run("typecheck");
    expect(first.code, first.log).toBe(0);
    fixture.seed("export declare const apiValue: ;\n");
    const invalid = fixture.run("typecheck");
    expect(invalid.code, invalid.log).not.toBe(0);
    expect(invalid.log).toContain("TS1110");
    fixture.seed("export declare const apiValue: 'C';\n");
    const repaired = fixture.run("typecheck");
    expect(repaired.code, repaired.log).toBe(0);
    expect(fixture.count("typecheck")).toBe(3);
    const cached = fixture.run("typecheck");
    expect(cached.code, cached.log).toBe(0);
    expect(fixture.count("typecheck")).toBe(3);
  } finally {
    fixture.dispose();
  }
}, 120_000);
