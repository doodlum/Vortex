import fs from "node:fs";
import path from "node:path";

import { Extractor, ExtractorConfig } from "@microsoft/api-extractor";
import { expect, it } from "vitest";

import { packageRoot, testWorkspace } from "./testWorkspace";

it("writes LF API reports on creation and after an API change", () => {
  const fixture = testWorkspace();
  try {
    fixture.write(
      "package.json",
      JSON.stringify({ name: "api-newline-fixture", version: "1.0.0", types: "lib/index.d.ts" }),
    );
    fixture.write(
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: { target: "ES2022", module: "commonjs", types: [], skipLibCheck: true },
        include: ["lib/**/*.d.ts"],
      }),
    );
    fs.mkdirSync(path.join(fixture.root, "etc"));
    const production = ExtractorConfig.loadFile(path.join(packageRoot, "api-extractor.json"));
    const report = path.join(fixture.root, "etc/fixture.api.md");
    for (const name of ["hello", "goodbye"]) {
      fixture.write(
        "lib/index.d.ts",
        `/** @public */\nexport declare function ${name}(): string;\n`,
      );
      const config = ExtractorConfig.prepare({
        configObjectFullPath: path.join(fixture.root, "api-extractor.json"),
        packageJsonFullPath: path.join(fixture.root, "package.json"),
        configObject: {
          projectFolder: fixture.root,
          mainEntryPointFilePath: "<projectFolder>/lib/index.d.ts",
          newlineKind: production.newlineKind,
          compiler: { tsconfigFilePath: "<projectFolder>/tsconfig.json" },
          apiReport: {
            enabled: true,
            reportFileName: "fixture",
            reportFolder: "<projectFolder>/etc",
            reportTempFolder: "<projectFolder>/temp",
          },
          docModel: { enabled: false },
          dtsRollup: { enabled: false },
          tsdocMetadata: { enabled: false },
        },
      });
      const messages: string[] = [];
      const result = Extractor.invoke(config, {
        localBuild: true,
        messageCallback(message) {
          messages.push(message.text);
          message.handled = true;
        },
      });
      expect(result.succeeded, messages.join("\n")).toBe(true);
      const bytes = fs.readFileSync(report);
      expect(bytes.toString()).toContain(`function ${name}()`);
      expect(bytes.includes(10)).toBe(true);
      expect(bytes.includes(13), "Generated API report must use LF").toBe(false);
    }
    expect(fs.readFileSync(report, "utf8")).not.toContain("function hello()");
  } finally {
    fixture.dispose();
  }
});
