import type * as fomodT from "@nexusmods/fomod-installer-native";

import { log } from "@/logging";
import type { ISupportedResult } from "@/types/api";
import lazyRequire from "@/util/lazyRequire";

export class VortexModTester {
  readonly #fomod: typeof fomodT;

  static async create(): Promise<VortexModTester | null> {
    try {
      // Keep native-module loading consistent with VortexModInstaller. A
      // webpack dynamic import can resolve to webpack's external-module shim
      // instead of the CommonJS exports in a packaged Electron application.
      const nativeModule = lazyRequire<typeof fomodT>(() =>
        require("@nexusmods/fomod-installer-native"),
      );
      const fomod = normalizeFomodModule(nativeModule);
      if (fomod === undefined) {
        throw new Error("Native FOMOD module does not export NativeModInstaller");
      }
      return new VortexModTester(fomod);
    } catch (err) {
      log("error", "Failed to load native FOMOD module", err);
      return null;
    }
  }

  private constructor(fomod: typeof fomodT) {
    this.#fomod = fomod;
  }

  /**
   * Calls FOMOD's testSupport and converts the result to Vortex data
   */
  public testSupport = (files: string[], allowedTypes: string[]): ISupportedResult => {
    try {
      const result = this.#fomod.NativeModInstaller.testSupported(files, allowedTypes);
      return {
        supported: result.supported,
        requiredFiles: result.requiredFiles,
      };
    } catch (err) {
      log("error", "Failed to determine FOMOD installer support", err);
      return {
        supported: false,
        requiredFiles: [],
      };
    }
  };
}

export function normalizeFomodModule(
  nativeModule: typeof fomodT & { default?: typeof fomodT },
): typeof fomodT | undefined {
  // Depending on whether Electron, webpack, or Node performed the CJS/ESM
  // interop, a CommonJS module can acquire more than one `default` wrapper.
  // Follow only that well-defined wrapper instead of depending on one bundler's
  // namespace shape.
  let candidate: unknown = nativeModule;
  const seen = new Set<unknown>();
  while (candidate !== null && typeof candidate === "object" && !seen.has(candidate)) {
    seen.add(candidate);
    if ((candidate as typeof fomodT).NativeModInstaller !== undefined) {
      return candidate as typeof fomodT;
    }
    candidate = (candidate as { default?: unknown }).default;
  }
  return undefined;
}
