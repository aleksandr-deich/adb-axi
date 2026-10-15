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

describe("the home view and device columns", () => {
  test("the home view names the target and its foreground, and counts crashes for 15 minutes, then since the latest mark", async () => {
    await axi.ok(["app", "install", DEBUG_APK, "--clean-data"]);
    await axi.ok(["app", "start", PKG, "--fresh"]);
    const component = await axi.waitFocused((value) => value === `${PKG}/.MainActivity`);
    const online = (await axi.adbHost(["devices"])).stdout
      .split("\n")
      .filter((line) => line.endsWith("\tdevice")).length;
    const home = await axi.ok([]);
    expect(home).toMatchObject({
      count: `${online} attached, ${online} online`,
      target: axi.serial,
      foreground: component,
    });
    expect(String(home.crashes)).toMatch(/^\d+ in the last 15m \(no log mark yet\)$/);
    expect((await axi.unselected(["-s", axi.serial])).json).toMatchObject({ target: axi.serial });

    const time = (await axi.mark("home")).slice(11, 19);
    const marked = await axi.ok([]);
    expect(String(marked.crashes)).toMatch(
      new RegExp(`^0 since ${time} \\(latest mark home, set \\d+ s ago\\)$`),
    );
    expect(marked.help).toEqual([
      `Run \`adb-axi logs --pkg ${PKG} --since 1m --device ${axi.serial}\` for recent app logs`,
    ]);
  });

  test("devices --fields reads each extra column from the device", async () => {
    const devices = await axi.ok(["devices", "--fields", "boot,data_free,model,abi,uptime"]);
    const row = (devices.devices as Record<string, unknown>[]).find(
      (device) => device.serial === axi.serial,
    );
    expect(row).toBeDefined();
    expect(Object.keys(row ?? {})).toEqual([
      "serial",
      "avd",
      "state",
      "api",
      "form",
      "boot",
      "data_free",
      "model",
      "abi",
      "uptime",
    ]);
    expect(row?.boot).toBe(
      (await axi.sh("getprop sys.boot_completed")).trim() === "1" ? "completed" : "booting",
    );
    expect(row?.model).toBe((await axi.sh("getprop ro.product.model")).trim());
    expect(row?.abi).toBe((await axi.sh("getprop ro.product.cpu.abi")).trim());
    const freeKiB = Number((await axi.sh("df -k /data | tail -1")).trim().split(/\s+/)[3]);
    const free = /^([\d.]+)G$/.exec(String(row?.data_free));
    if (free) expect(Math.abs(Number(free[1]) - freeKiB / 1024 / 1024)).toBeLessThanOrEqual(0.1);
    const uptime = Number((await axi.sh("cat /proc/uptime")).trim().split(" ")[0]);
    const parts = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(String(row?.uptime));
    expect(parts, String(row?.uptime)).not.toBeNull();
    const seconds =
      Number(parts?.[1] ?? 0) * 3600 + Number(parts?.[2] ?? 0) * 60 + Number(parts?.[3] ?? 0);
    expect(Math.abs(seconds - uptime)).toBeLessThanOrEqual(60 + 5);

    const unknown = await axi.run(["devices", "--fields", "bogus"]);
    expect(unknown.exitCode).toBe(2);
    expect(unknown.json).toMatchObject({
      error: '--fields has unknown column "bogus"',
      code: "VALIDATION_ERROR",
      valid_values: ["boot", "data_free", "model", "abi", "uptime"],
    });
  });
});
