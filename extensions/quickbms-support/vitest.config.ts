import { defineConfig, mergeConfig } from "vitest/config";

import baseConfig from "../../vitest.base.config";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: { environment: "node", include: ["src/**/*.test.ts"] },
  }),
);
