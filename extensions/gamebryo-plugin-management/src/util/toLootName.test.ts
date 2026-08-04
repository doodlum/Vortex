import { describe, expect, it } from "vitest";

import { IPlugins } from "../types/IPlugins";
import { toLootName } from "./toLootName";

function list(entries: { [id: string]: string }): IPlugins {
  return Object.keys(entries).reduce((prev, id) => {
    prev[id] = { filePath: entries[id] } as any;
    return prev;
  }, {} as IPlugins);
}

describe("toLootName", () => {
  it("restores the on-disk case that the plugin id lost", () => {
    const plugins = list({ "dragonborn.esm": "/games/Skyrim/Data/Dragonborn.esm" });
    expect(toLootName("dragonborn.esm", plugins)).toBe("Dragonborn.esm");
  });

  it("strips the ghost suffix, which libloot appends itself", () => {
    const plugins = list({ "skyui.esp": "/games/Skyrim/Data/SkyUI.esp.ghost" });
    expect(toLootName("skyui.esp", plugins)).toBe("SkyUI.esp");
  });

  it("accepts a name that is not yet an id", () => {
    const plugins = list({ "dragonborn.esm": "/games/Skyrim/Data/Dragonborn.esm" });
    expect(toLootName("Dragonborn.esm.ghost", plugins)).toBe("Dragonborn.esm");
  });

  it("falls back to the id when the plugin has no known path", () => {
    expect(toLootName("Unknown.esp", list({}))).toBe("unknown.esp");
  });
});
