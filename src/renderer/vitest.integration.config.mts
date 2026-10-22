import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, mergeConfig } from "vitest/config";

import rendererConfig from "./vitest.config.mts";

const directory = path.dirname(fileURLToPath(import.meta.url));

const config = mergeConfig(
  rendererConfig,
  defineConfig({
    test: { include: ["tests/**/*.test.ts"] },
    resolve: {
      alias: {
        "@nexusmods/vortex-api": path.resolve(
          directory,
          "../../packages/extension-test-mocks/src/index.ts",
        ),
      },
    },
  }),
);

// Vite concatenates include arrays during merging; keep this target separate from unit tests.
config.test = { ...config.test, include: ["tests/**/*.test.ts"] };
export default config;
