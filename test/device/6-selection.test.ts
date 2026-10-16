import { describe, expect, test } from "vitest";
import { Axi, DEBUG_APK, PKG } from "./support.js";

const axi = new Axi(import.meta.filename);

/** The emulator's own adb port, which `adb connect` can attach a second time over TCP. */
function secondSerial(): string {
  const console = /^emulator-(\d+)$/.exec(axi.serial)?.[1];
  expect(console, `${axi.serial} is not an emulator serial`).toBeDefined();
  return `localhost:${Number(console) + 1}`;
}

async function onlineSerials(): Promise<string[]> {
  const listing = await axi.adbHost(["devices"]);
  return listing.stdout
    .split("\n")
    .map((line) => line.split("\t"))
    .filter(([, state]) => state?.trim() === "device")
    .map(([serial]) => serial ?? "");
}

async function waitForSerials(accept: (serials: string[]) => boolean): Promise<string[]> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const serials = await onlineSerials();
    if (accept(serials)) return serials;
    expect(Date.now(), `adb devices: ${serials.join(", ")}`).toBeLessThan(deadline);
  }
}

describe("device selection with two real transports of one emulator", () => {
  test("both are listed, every device command refuses to guess, each serial has its own marks, and one transport is chosen alone", async () => {
    await axi.ok(["app", "install", DEBUG_APK, "--clean-data"]);
    await axi.ok(["app", "start", PKG]);
    const second = secondSerial();
    const connected = await axi.adbHost(["connect", second]);
    expect(connected.stdout).toMatch(/connected to/);
    try {
      const serials = await waitForSerials((list) => list.includes(second));
      expect(serials).toEqual(expect.arrayContaining([axi.serial, second]));

      const devices = await axi.unselected(["devices"]);
      expect(devices.exitCode).toBe(0);
      expect(devices.json.count).toBe(`${serials.length} attached, ${serials.length} online`);
      expect(
        (devices.json.devices as { serial: string }[]).map((device) => device.serial).sort(),
      ).toEqual([...serials].sort());

      for (const command of [
        ["app", "current"],
        ["logs", "crash"],
        ["shell", "--", "id"],
        ["wait", "app", PKG, "--state", "running"],
        ["wait", "boot"],
        ["data", "db", PKG],
      ]) {
        const run = await axi.unselected(command);
        expect(run.exitCode, command.join(" ")).toBe(1);
        expect(run.json).toMatchObject({
          error: `${serials.length} devices are online and none is selected`,
          code: "DEVICE_AMBIGUOUS",
        });
        expect(
          (run.json.devices as { serial: string }[]).map((device) => device.serial).sort(),
        ).toEqual([...serials].sort());
        expect(run.json.help).toEqual(
          expect.arrayContaining(["Or export ANDROID_SERIAL=<serial> in this shell"]),
        );
      }

      const doctor = await axi.unselected(["doctor"]);
      expect(doctor.exitCode).toBe(1);
      const deviceCheck = (
        doctor.json.checks as { check: string; status: string; detail: string }[]
      ).find((check) => check.check === "device");
      expect(deviceCheck?.status).toBe("failed");
      expect(deviceCheck?.detail).toMatch(
        new RegExp(`^${serials.length} devices are online and none is selected: `),
      );
      for (const serial of serials) expect(deviceCheck?.detail).toContain(`${serial} online`);

      const home = await axi.unselected([]);
      expect(home.exitCode).toBe(0);
      expect(home.json).toMatchObject({
        target: "-",
        target_note: `${serials.length} devices are online and none is selected`,
      });

      const viaEmulator = await axi.ok(["app", "current"]);
      const avd = (devices.json.devices as { serial: string; avd: string }[]).find(
        (device) => device.serial === axi.serial,
      )?.avd;
      if (avd !== undefined && avd !== "-") {
        const byName = await axi.unselected(["app", "current", "--device", avd]);
        expect(byName.exitCode).toBe(0);
        expect(byName.json).toEqual(viaEmulator);
      }
      const viaTcp = await axi.unselected(["app", "current", "--device", second]);
      expect(viaTcp.exitCode).toBe(0);
      expect(viaTcp.json).toEqual(viaEmulator);

      await axi.mark("per-serial");
      const elsewhere = await axi.unselected(["logs", "--since", "per-serial", "--device", second]);
      expect(elsewhere.exitCode).toBe(1);
      expect(elsewhere.json).toMatchObject({
        code: "MARK_NOT_FOUND",
        error: `no log mark named per-serial on ${second}`,
      });
    } finally {
      await axi.adbHost(["disconnect", second]);
      await waitForSerials((list) => !list.includes(second));
    }

    const alone = await waitForSerials((list) => !list.includes(second));
    if (alone.length === 1) {
      const auto = await axi.unselected(["app", "current"]);
      expect(auto.exitCode).toBe(0);
      expect(auto.json).toEqual(await axi.ok(["app", "current"]));
    }
  });

  test("--debug shows every adb call with the serial, and an unknown serial is DEVICE_NOT_FOUND", async () => {
    const debug = await axi.run(["app", "current", "--debug"]);
    expect(debug.exitCode).toBe(0);
    const calls = debug.stderr.split("\n").filter((line) => /^debug: adb /.test(line));
    expect(calls[0]).toBe("debug: adb devices -l");
    expect(calls.length).toBeGreaterThan(1);
    for (const call of calls.slice(1).filter((call) => call !== "debug: adb version"))
      expect(call).toMatch(new RegExp(`^debug: adb -s ${axi.serial} `));
    expect(
      debug.stderr.split("\n").filter((line) => line !== "" && !line.startsWith("debug: ")),
    ).toEqual([]);

    const missing = await axi.unselected(["app", "current", "--device", "emulator-5998"]);
    expect(missing.exitCode).toBe(1);
    expect(missing.json).toMatchObject({
      error: "no attached device has the serial or AVD name emulator-5998",
      code: "DEVICE_NOT_FOUND",
    });
    expect((missing.json.devices as { serial: string }[]).map((device) => device.serial)).toContain(
      axi.serial,
    );
  });
});
