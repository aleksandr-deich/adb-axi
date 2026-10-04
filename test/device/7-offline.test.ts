import { execFileSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { Axi } from "./support.js";

const axi = new Axi(import.meta.filename);

// Runs last: it shuts the emulator down.
describe("offline device", () => {
  test("a command against a stopped emulator fails at once with a typed error", async () => {
    execFileSync("adb", ["-s", axi.serial, "emu", "kill"], { timeout: 30_000 });
    // Poll adb-axi itself until adb no longer lists the emulator as online.
    const deadline = Date.now() + 60_000;
    for (;;) {
      const devices = await axi.run(["devices"]);
      const listed = (devices.json.devices ?? []) as { serial: string; state: string }[];
      if (!listed.some((d) => d.serial === axi.serial && d.state === "device")) break;
      expect(Date.now(), "the emulator is still online").toBeLessThan(deadline);
    }

    const run = await axi.run(["app", "current"]);
    expect(run.exitCode).not.toBe(0);
    expect(["DEVICE_OFFLINE", "DEVICE_NOT_FOUND"]).toContain(run.json.code);
    expect(run.durationMs).toBeLessThan(2_000);
  });
});
