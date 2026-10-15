import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { AdbClient } from "../../src/adb/run.js";
import { readPackage } from "../../src/android/packages.js";
import { Deadline } from "../../src/core/deadline.js";
import { createFakeAdb, FIXTURES_DIR } from "../fake-adb/harness.js";

interface CapturedPackage {
  facts: Record<"before" | "after", { dump: string; path: string }>;
}

it("reads retained API 29/30 package records as not installed when captured code paths are absent", async () => {
  for (const api of [29, 30]) {
    const captured = JSON.parse(
      readFileSync(join(FIXTURES_DIR, "diagnostic", String(api), "keep-data-package.json"), "utf8"),
    ) as CapturedPackage;
    for (const state of ["before", "after"] as const) {
      const facts = captured.facts[state];
      const fake = createFakeAdb({
        description: `API ${api} captured ${state} keep-data uninstall facts`,
        rules: [
          {
            match: ["-s", "emulator-5554", "shell", "dumpsys package dev.probe"],
            respond: { stdout: facts.dump },
          },
          {
            match: ["-s", "emulator-5554", "shell", "pm path --user 0 dev.probe"],
            respond: { stdout: facts.path },
          },
        ],
      });
      try {
        const adb = new AdbClient(join(fake.binDir, "adb"), { env: fake.env });
        const info = await readPackage(adb, "emulator-5554", "dev.probe", {
          deadline: new Deadline(10_000),
        });
        expect(info, `API ${api} ${state}`).toMatchObject({
          package: "dev.probe",
          installed: state === "before",
          versionName: "1.0",
          versionCode: 1,
          debuggable: true,
        });
        expect(fake.unmatched()).toEqual([]);
      } finally {
        fake.cleanup();
      }
    }
  }
});
