import { describe, expect, test } from "vitest";
import { Axi } from "./support.js";

const axi = new Axi(import.meta.filename);

/** `wait boot` treats a device up for less than this as fresh and waits for its services to settle. */
const FRESH_UPTIME_S = 300;

async function uptime(): Promise<number> {
  return Number((await axi.sh("cat /proc/uptime")).trim().split(" ")[0]);
}

// Runs just before the offline check: it reboots the emulator and waits for it again.
describe("a real reboot", () => {
  test("wait boot: a no-op when long up, a timeout with the last state while rebooting, then a wait until the services answer; old marks are dropped once", async () => {
    const before = await axi.run(["wait", "boot"]);
    expect(before.exitCode).toBe(0);
    if ((await uptime()) >= FRESH_UPTIME_S) {
      expect(before.json).toMatchObject({
        ok: `wait boot ${axi.serial} -> already booted (no-op)`,
        noop: true,
      });
    }
    await axi.mark("before-reboot");

    expect((await axi.adb(["reboot"])).exitCode).toBe(0);
    const rebooting = await axi.run(["wait", "boot", "--timeout", "2s"]);
    expect(rebooting.exitCode).toBe(1);
    expect(rebooting.durationMs).toBeLessThan(2_000 + 2_000);
    expect(rebooting.json).toMatchObject({
      error: `${axi.serial} had not finished booting after 2 s`,
      code: "WAIT_TIMEOUT",
      help: [`Run \`adb-axi doctor --device ${axi.serial}\` to see why`],
    });
    const last = rebooting.json.last as Record<string, unknown>;
    expect(Object.keys(last)).toEqual([
      "state",
      "boot_completed",
      "uptime_s",
      "package_service",
      "activity_service",
    ]);
    expect(last.boot_completed === "-" || last.boot_completed === false).toBe(true);

    const booted = await axi.run(["wait", "boot", "--timeout", "300s"], 330_000);
    expect(booted.exitCode).toBe(0);
    expect(String(booted.json.ok)).toMatch(
      new RegExp(`^wait boot ${axi.serial} -> booted after \\d+ ms$`),
    );
    expect(await axi.sh("getprop sys.boot_completed")).toBe("1");
    expect(await axi.sh("pm path android")).toMatch(/^package:/m);
    expect((await axi.sh("am get-current-user")).trim()).toMatch(/^\d+$/);
    expect(await uptime()).toBeLessThan(FRESH_UPTIME_S);

    const dropped = await axi.run(["logs", "--since", "before-reboot"]);
    expect(dropped.exitCode).toBe(1);
    expect(dropped.json).toEqual({
      error: `no log mark named before-reboot on ${axi.serial}`,
      code: "MARK_NOT_FOUND",
      marks: [],
      marks_note: "Log marks from a previous device or boot were dropped",
      help: [`Run \`adb-axi logs mark before-reboot --device ${axi.serial}\` to record it now`],
    });
    await axi.mark("after-reboot");
    const once = await axi.run(["logs", "--since", "before-reboot"]);
    expect(once.json).not.toHaveProperty("marks_note");
    expect(once.json.marks).toEqual(["after-reboot"]);
  });

  test("a device that never attaches times out naming it, by --device or ANDROID_SERIAL", async () => {
    const absent = "emulator-5996";
    for (const run of [
      await axi.unselected(["wait", "boot", "--device", absent, "--timeout", "2s"]),
      await axi.unselected(["wait", "boot", "--timeout", "2s"], 30_000, { ANDROID_SERIAL: absent }),
    ]) {
      expect(run.exitCode).toBe(1);
      expect(run.json).toEqual({
        error: `${absent} had not finished booting after 2 s`,
        code: "WAIT_TIMEOUT",
        last: {
          state: "not attached",
          boot_completed: "-",
          uptime_s: "-",
          package_service: "-",
          activity_service: "-",
        },
        help: [`Run \`adb-axi doctor --device ${absent}\` to see why`],
      });
    }
  });
});
