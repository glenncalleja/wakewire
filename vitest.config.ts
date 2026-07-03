import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: [
        "src/core/**/*.ts",
        "src/sources/github/verify.ts",
        "src/sources/github/trim.ts",
        "src/sources/gmail/extract.ts",
        "src/db/**/*.ts",
      ],
      exclude: ["src/**/*.test.ts"],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
      },
    },
  },
});
