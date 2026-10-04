import { describe, expect, test } from "vitest";
import { Axi } from "./support.js";

const axi = new Axi(import.meta.filename);

// Leaked and wedged holders need the Android CLI's instrumentation server, which CI does
// not have; README.md lists that check as a local step.
describe("doctor ui", () => {
  test("reports UiAutomation free when nothing holds it", async () => {
    const run = await axi.run(["doctor", "ui"]);
    expect(run.exitCode).toBe(0);
    expect(run.json).toEqual({ uiautomation: "free" });
  });
});
