import { afterEach, describe, expect, it } from "vitest";
import { createFakeAdb, type FakeAdb } from "../fake-adb/harness.js";
import { runCli } from "../helpers/run.js";

let fake: FakeAdb | undefined;
afterEach(() => {
  fake?.cleanup();
  fake = undefined;
});

// An actual old platform-tools build is unavailable in device CI. Simulate its
// documented version protocol, not the interrupted-shell bug itself. The approved
// host-floor contract requires refusal before any device call, and a failing doctor check.
function oldClient(): FakeAdb {
  fake = createFakeAdb({
    synthetic: true,
    source: "Host-floor contract: Platform-Tools 35.0.0 fixes shell disconnect return codes",
    rules: [
      {
        match: ["version"],
        respond: { stdout: "Android Debug Bridge version 1.0.41\nVersion 34.0.5-10900879\n" },
      },
      {
        match: ["devices", "-l"],
        respond: { stdout: "List of devices attached\nemulator-5554 device\n" },
      },
    ],
  });
  return fake;
}

describe("host adb client floor (simulated old client)", () => {
  it("refuses a device command with found and required versions before touching the device", async () => {
    const f = oldClient();
    const result = await runCli(["app", "list", "--device", "emulator-5554", "--json"], f.env);
    expect(result.exitCode).toBe(1);
    const data = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(data).toMatchObject({ code: "HOST_ADB_TOO_OLD", found: "34.0.5", required: "35.0.0" });
    expect(data.error).toContain("34.0.5");
    expect(data.error).toContain("35.0.0");
    expect(String(data.help)).toContain("Update Android SDK Platform-Tools");
    expect(f.calls().filter((call) => call.argv[0] === "-s")).toEqual([]);
    expect(f.unmatched()).toEqual([]);
  });

  it("reports the old adb client as a failing doctor check with the update fix", async () => {
    const f = oldClient();
    const result = await runCli(["doctor", "--json"], f.env);
    expect(result.exitCode).toBe(1);
    const data = JSON.parse(result.stdout) as {
      checks: { check: string; status: string; detail: string }[];
      help: string[];
    };
    const adb = data.checks.find((row) => row.check === "adb");
    expect(adb?.status).toBe("failed");
    expect(adb?.detail).toMatch(/34\.0\.5.*35\.0\.0/);
    expect(data.help.join("\n")).toContain("Update Android SDK Platform-Tools to 35.0.0");
    expect(data.help.join("\n")).toContain("adb-axi never updates it");
    expect(f.calls().filter((call) => call.argv[0] === "-s")).toEqual([]);
    expect(f.unmatched()).toEqual([]);
  });
});
