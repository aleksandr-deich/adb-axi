import { defineConfig } from "vitest/config";

// Real-emulator checks. Never part of `npm test` or CI.
export default defineConfig({
  test: {
    include: ["test/device/**/*.test.ts"],
    passWithNoTests: true,
    testTimeout: 300_000,
  },
});
