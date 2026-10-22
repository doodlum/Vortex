import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { expect, expectTypeOf, test } from "vitest";

import IniParser, { IniFile, PortableIniFormat } from "./index";

interface Document {
  Settings: { base_directory: string };
  General: { gameName: string };
}
test("IniFile generic describes the complete document used by bundled consumers", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "vortex-ini-api-"));
  try {
    const target = path.join(directory, "consumer.ini");
    await fs.writeFile(
      target,
      "[Settings]\r\nbase_directory=mods\r\n[General]\r\ngameName=example\r\n",
    );
    const parser = new IniParser(new PortableIniFormat());
    const file: IniFile<Document> = await parser.read<Document>(target);
    expectTypeOf(file.data.Settings.base_directory).toEqualTypeOf<string>();
    expectTypeOf(file.data.General.gameName).toEqualTypeOf<string>();
    expect(file.data.Settings.base_directory).toBe("mods");
    file.data.General.gameName = "changed";
    await parser.write(target, file);
    expect((await parser.read<Document>(target)).data.General.gameName).toBe("changed");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
