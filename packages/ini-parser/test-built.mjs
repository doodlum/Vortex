import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "vortex-ini-built-"));
try {
  for (const mode of ["commonjs", "module"]) {
    const file = path.join(directory, mode + ".ini");
    await fs.writeFile(file, "; keep\r\n[General]\r\nName=before\r\n");
    const load =
      mode === "module"
        ? 'await import("@nexusmods/ini-parser")'
        : 'require("@nexusmods/ini-parser")';
    const program = `const m = ${load};
      const parser = new m.default(new m.WinapiFormat());
      const file = ${JSON.stringify(file)};
      const ini = await parser.read(file);
      if (ini.data.General.Name !== "before") throw new Error("Built backend did not read the file");
      ini.data.General.Name = "after";
      await parser.write(file, ini);
      if ((await parser.read(file)).data.General.Name !== "after") throw new Error("Built backend did not commit the file");`;
    const code =
      mode === "module"
        ? program
        : "(async () => {" +
          program +
          "})().catch(error => { console.error(error); process.exitCode = 1; })";
    execFileSync(process.execPath, ["--input-type=" + mode, "-e", code], {
      cwd: import.meta.dirname,
      env: { ...process.env, NODE_OPTIONS: "" },
      stdio: "inherit",
    });
    const bytes = await fs.readFile(file, "utf8");
    assert.ok(bytes.includes("; keep") && bytes.includes("Name=after"));
    console.log(mode + " built entry: read/write/comments PASS");
  }
} finally {
  assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
  assert.ok(path.basename(directory).startsWith("vortex-ini-built-"));
  await fs.rm(directory, { recursive: true, force: true });
}
