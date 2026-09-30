import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.ts", "test/cli/**/*.test.ts"],
    exclude: ["test/device/**", "node_modules/**", "dist/**"],
  },
});
