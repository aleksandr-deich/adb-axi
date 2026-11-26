import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // CLI workers spawn Node-based adb processes; bound contention on real-time deadlines.
    maxWorkers: 2,
    include: ["test/unit/**/*.test.ts", "test/cli/**/*.test.ts"],
    exclude: ["test/device/**", "node_modules/**", "dist/**"],
  },
});
