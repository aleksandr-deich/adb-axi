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

    // With nothing else attached (the CI case), the empty state is definitive and exits 0.
    const attached = (await axi.adbHost(["devices"])).stdout
      .split("\n")
      .slice(1)
      .filter((line) => line.trim() !== "");
    if (attached.length === 0) {
      const devices = await axi.unselected(["devices"]);
      expect(devices.exitCode).toBe(0);
      expect(devices.json).toEqual({
        count: "0 attached, 0 online",
        devices: [],
        help: ["Start an emulator or connect a device, then run `adb-axi devices` again"],
      });
      const home = await axi.unselected([]);
      expect(home.exitCode).toBe(0);
      expect(home.json).toMatchObject({
        count: "0 attached, 0 online",
        devices: [],
        target: "-",
        target_note: "no device is attached",
        help: ["Start an emulator or connect a device, then run `adb-axi` again"],
      });
      const doctor = await axi.unselected(["doctor"]);
      expect(doctor.exitCode).toBe(1);
      expect(doctor.json.summary).toBe("3 run, 2 ok, 0 warn, 1 failed");
      expect(doctor.json.checks).toContainEqual({
        check: "device",
        status: "failed",
        detail: "no device is attached",
      });
    }
  });
});
