import { defineConfig } from "vitest/config";
import { BaseSequencer, type TestSpecification } from "vitest/node";

/**
 * Files run one at a time in name order, because they share one emulator and the last one
 * (`7-offline`) shuts it down.
 */
class ByName extends BaseSequencer {
  override sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    return Promise.resolve([...files].sort((a, b) => a.moduleId.localeCompare(b.moduleId)));
  }
}

// Real-emulator checks (`npm run test:device`). Never part of `npm test` or `npm run check`.
export default defineConfig({
  test: {
    include: ["test/device/**/*.test.ts"],
    globalSetup: ["test/device/setup.ts"],
    fileParallelism: false,
    sequence: { sequencer: ByName },
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
