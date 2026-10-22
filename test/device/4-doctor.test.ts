import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { Axi } from "./support.js";

const axi = new Axi(import.meta.filename);

interface Check {
  check: string;
  status: "ok" | "warn" | "failed";
  detail: string;
}

const SCALES = ["window_animation_scale", "transition_animation_scale", "animator_duration_scale"];

function checks(report: Record<string, unknown>): Record<string, Check> {
  return Object.fromEntries((report.checks as Check[]).map((check) => [check.check, check]));
}

function summaryOf(report: Record<string, unknown>): string {
  const list = report.checks as Check[];
  const count = (status: string): number => list.filter((check) => check.status === status).length;
  return `${list.length} run, ${count("ok")} ok, ${count("warn")} warn, ${count("failed")} failed`;
}

/** The animation scales as `settings` stores them, `null` for never set. */
async function scales(): Promise<string[]> {
  return Promise.all(
    SCALES.map(async (key) => (await axi.sh(`settings get global ${key}`)).trim()),
  );
}

async function setScales(values: readonly string[]): Promise<void> {
  for (const [i, key] of SCALES.entries()) {
    const value = values[i] ?? "null";
    await axi.sh(
      value === "null" ? `settings delete global ${key}` : `settings put global ${key} ${value}`,
    );
  }
}

/** A TCP port nothing listens on right now. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        resolve(typeof address === "object" && address !== null ? address.port : 0);
      });
    });
  });
}

describe("doctor on a real emulator", () => {
  test("every check agrees with what the device and the host say", async () => {
    const run = await axi.run(["doctor"]);
    const report = run.json;
    const all = checks(report);
    expect(Object.keys(all)).toEqual([
      "adb",
      "server",
      "device",
      "boot",
      "clock",
      "data_free",
      "animations",
      "ime",
      "instrumentation",
      "console_token",
    ]);
    expect(report.summary).toBe(summaryOf(report));
    expect(run.exitCode).toBe(
      Object.values(all).some((check) => check.status === "failed") ? 1 : 0,
    );
    expect(report.target).toBe(axi.serial);

    const version = /Version (\d+\.\d+\.\d+)/.exec((await axi.adbHost(["version"])).stdout)?.[1];
    expect(all.adb?.status).toBe("ok");
    expect(all.adb?.detail).toMatch(new RegExp(`^${(version ?? "-").replaceAll(".", "\\.")} at `));
    expect(all.server).toEqual({
      check: "server",
      status: "ok",
      detail:
        process.env.ADB_SERVER_SOCKET ??
        `tcp:${process.env.ANDROID_ADB_SERVER_ADDRESS === undefined ? "" : `${process.env.ANDROID_ADB_SERVER_ADDRESS}:`}${process.env.ANDROID_ADB_SERVER_PORT || "5037"}`,
    });
    const attached = (await axi.adbHost(["devices"])).stdout
      .split("\n")
      .slice(1)
      .map((line) => line.split("\t"))
      .filter(([serial, state]) => serial !== "" && state !== undefined)
      .map(([serial, state]) => `${serial ?? ""} ${state === "device" ? "online" : (state ?? "")}`);
    expect(all.device).toEqual({ check: "device", status: "ok", detail: attached.join(", ") });
    expect((await axi.sh("getprop sys.boot_completed")).trim()).toBe("1");
    expect(all.boot).toEqual({ check: "boot", status: "ok", detail: "boot finished" });
    const skew = Math.abs(Number((await axi.sh("date +%s")).trim()) - Date.now() / 1000);
    expect(all.clock?.status).toBe(skew < 60 ? "ok" : "warn");

    const df = (await axi.sh("df -k /data | tail -1")).trim().split(/\s+/);
    const freeGiB = Number(df[3]) / 1024 / 1024;
    const shown = /^([\d.]+)([KMG]) free$/.exec(all.data_free?.detail ?? "");
    expect(shown, all.data_free?.detail).not.toBeNull();
    if (shown?.[2] === "G") expect(Math.abs(Number(shown[1]) - freeGiB)).toBeLessThanOrEqual(0.1);

    const current = await scales();
    const off = current.every((value) => value === "0" || value === "0.0");
    expect(all.animations?.status).toBe(off ? "ok" : "warn");
    const ime = (await axi.sh("settings get secure default_input_method")).trim();
    expect(ime).toMatch(/LatinIME|inputmethod/);
    expect(all.ime).toEqual({ check: "ime", status: "ok", detail: "standard keyboard" });
    expect(all.console_token).toEqual({
      check: "console_token",
      status: "ok",
      detail: "token present, console answers",
    });
  });

  test("an unattached --device stops the report at the device check, naming what is attached", async () => {
    const run = await axi.unselected(["doctor", "--device", "emulator-5998"]);
    expect(run.exitCode).toBe(1);
    expect(run.json.summary).toBe("3 run, 2 ok, 0 warn, 1 failed");
    const device = checks(run.json).device;
    expect(device?.status).toBe("failed");
    expect(device?.detail).toMatch(
      new RegExp(
        `^no attached device has the serial or AVD name emulator-5998: .*${axi.serial} online`,
      ),
    );
    expect(run.json.help).toEqual([
      "Run `adb-axi doctor --device <serial or avd>` with one of the devices above",
    ]);
  });

  test("animation scales warn with exit 0 whether set or never set, and all 0 is ok", async () => {
    const original = await scales();
    try {
      await setScales(["0", "0", "0"]);
      expect(checks((await axi.run(["doctor"])).json).animations).toEqual({
        check: "animations",
        status: "ok",
        detail: "scales 0",
      });

      await setScales(["1.0", "0", "null"]);
      const run = await axi.run(["doctor"]);
      expect(checks(run.json).animations).toEqual({
        check: "animations",
        status: "warn",
        detail: "window 1.0, transition 0, animator 1.0, animations can make UI steps flaky",
      });
      expect(run.json.help).toContain(
        `Run \`adb-axi shell --device ${axi.serial} -- 'settings put global window_animation_scale 0; settings put global transition_animation_scale 0; settings put global animator_duration_scale 0'\` to turn animations off (this changes the device's settings)`,
      );
      if (!Object.values(checks(run.json)).some((check) => check.status === "failed")) {
        expect(run.exitCode).toBe(0);
      }
    } finally {
      await setScales(original);
      expect(await scales()).toEqual(original);
    }
  });

  test("the console token: missing warns, empty fails with exit 1", async () => {
    const home = mkdtempSync(join(tmpdir(), "adb-axi-device-token-"));
    try {
      const missing = await axi.runWithEnv(["doctor"], { HOME: home });
      expect(checks(missing.json).console_token).toEqual({
        check: "console_token",
        status: "warn",
        detail:
          "~/.emulator_console_auth_token is missing, the emulator console may refuse commands",
      });
      expect(missing.json.help).toContain(
        "Restart the emulator so it writes a fresh console token",
      );

      writeFileSync(join(home, ".emulator_console_auth_token"), "");
      const empty = await axi.runWithEnv(["doctor"], { HOME: home });
      expect(empty.exitCode).toBe(1);
      expect(checks(empty.json).console_token).toEqual({
        check: "console_token",
        status: "failed",
        detail: "~/.emulator_console_auth_token is empty",
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("an adb server that was not running is started, reported with its port, and stopped again", async () => {
    const baseline = await axi.adbHost(["devices", "-l"]);
    expect(baseline.exitCode).toBe(0);
    const port = String(await freePort());
    try {
      const run = await axi.runWithEnv(["doctor"], {
        ADB_SERVER_SOCKET: undefined,
        ANDROID_ADB_SERVER_ADDRESS: undefined,
        ANDROID_ADB_SERVER_PORT: port,
        ADB_USB: "0",
        ADB_EMU: "0",
        ADB_MDNS: "0",
      });
      expect(checks(run.json).server).toEqual({
        check: "server",
        status: "warn",
        detail: `tcp:${port} was not running, adb started it just now`,
      });
    } finally {
      const stopped = await axi.adbHost(["-L", `tcp:${port}`, "kill-server"]);
      expect(stopped.exitCode).toBe(0);
      const after = await axi.adbHost(["devices", "-l"]);
      expect(after.exitCode).toBe(0);
      expect(after.stdout).toBe(baseline.stdout);
      expect(after.stderr).not.toMatch(/daemon not running|daemon started successfully/);
    }
  });
});
