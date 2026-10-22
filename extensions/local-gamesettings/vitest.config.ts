import { fileURLToPath } from "node:url";

import { mergeConfig } from "vitest/config";

import baseConfig from "../../vitest.base.config";

export default mergeConfig(baseConfig, {
  resolve: {
    alias: [
      {
        find: /^@nexusmods\/vortex-api$/,
        replacement: fileURLToPath(
          new URL("../../packages/extension-test-mocks/src/index.ts", import.meta.url),
        ),
      },
    ],
  },
  test: {
    name: "local-gamesettings",
    include: ["src/**/*.test.ts"],
  },
});
