import type * as fomodT from "@nexusmods/fomod-installer-native";
import { describe, expect, it } from "vitest";

import { normalizeFomodModule } from "./VortexModTester";

describe("normalizeFomodModule", () => {
  it("accepts direct CommonJS exports", () => {
    const native = { NativeModInstaller: class {} } as unknown as typeof fomodT;
    expect(normalizeFomodModule(native)).toBe(native);
  });

  it("unwraps a default export produced by module interop", () => {
    const native = { NativeModInstaller: class {} } as unknown as typeof fomodT;
    const wrapped = { default: native } as typeof fomodT & { default: typeof fomodT };
    expect(normalizeFomodModule(wrapped)).toBe(native);
  });

  it("unwraps repeated defaults produced by layered module interop", () => {
    const native = { NativeModInstaller: class {} } as unknown as typeof fomodT;
    const wrapped = { default: { default: native } } as unknown as typeof fomodT & {
      default: typeof fomodT;
    };
    expect(normalizeFomodModule(wrapped)).toBe(native);
  });
});
