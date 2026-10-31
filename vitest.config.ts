import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/runtime/__tests__/**/*.test.ts",
      "src/capabilities/__tests__/**/*.test.ts",
      "src/model-gateway/**/*.test.ts",
      "src/provider-auth/**/*.test.ts",
      "src/sessions/**/*.test.ts",
      "src/shared/**/*.test.ts",
      "src/web-ui/**/*.test.ts",
      "tests/private/**/*.test.ts",
    ],
  },
});
