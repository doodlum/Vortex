import * as fs from "node:fs/promises";

import { expect, test } from "vitest";

test("Nx main cache includes every standalone worker bundle and source map", async () => {
  const script = await fs.readFile(new URL("./build.mjs", import.meta.url), "utf8");
  const manifest = JSON.parse(
    await fs.readFile(new URL("./package.json", import.meta.url), "utf8"),
  );
  const workers = [
    ...script.matchAll(/await\s+bundleWorker\(\s*["'][^"']+["']\s*,\s*["']([^"']+)["']\s*\)/g),
  ].map((match) => match[1]);
  expect(workers.length).toBeGreaterThan(0);
  const outputs = manifest.nx.targets.build.outputs;
  for (const worker of workers) {
    expect(outputs, worker).toContain("{projectRoot}/build/" + worker);
    expect(outputs, worker + " source map").toContain("{projectRoot}/build/" + worker + ".map");
  }
});
