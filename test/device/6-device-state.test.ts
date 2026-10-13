import { beforeAll, describe, expect, test } from "vitest";
import { Axi, DEBUG_APK, PKG } from "./support.js";

const axi = new Axi(import.meta.filename);

describe("attached device and foreground state", () => {
  beforeAll(async () => {
    await axi.ok(["app", "install", DEBUG_APK, "--clean-data"]);
  });

  test("devices reports the target's real serial, AVD name and API", async () => {
    const facts = await axi.ok([
      "shell",
      "getprop ro.boot.qemu.avd_name; getprop ro.kernel.qemu.avd_name; getprop ro.build.version.sdk",
    ]);
    const [bootAvd, kernelAvd, api] = String(facts.stdout).split("\n");
    const avd = bootAvd || kernelAvd;
    expect(avd).not.toBe("");
    expect(Number(api)).toBeGreaterThanOrEqual(29);
    const expected = { serial: axi.serial, avd, api: Number(api), state: "device" };
    const json = await axi.ok(["devices"]);
    expect(json.devices).toEqual(expect.arrayContaining([expect.objectContaining(expected)]));
    const text = await axi.text(["devices"]);
    expect(text.data).toEqual(json);
  });

  test("app current matches independently queried window focus and kernel PID", async () => {
    await axi.ok(["app", "start", PKG, "--fresh"]);
    const component = await axi.waitFocused((value) => value === `${PKG}/.MainActivity`);
    const pids = await axi.pidsOf(PKG);
    expect(pids).toHaveLength(1);
    const expected = { package: PKG, activity: component.split("/")[1], pid: pids[0] };
    const json = await axi.ok(["app", "current"]);
    expect(json).toEqual({ app: expected });
    const text = await axi.text(["app", "current"]);
    expect(text.data).toEqual(json);
    expect(text.stdout).toBe(
      `app:\n  package: ${PKG}\n  activity: .MainActivity\n  pid: ${pids[0]}\n`,
    );
  });
});
