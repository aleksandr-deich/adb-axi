import { beforeAll, describe, expect, test } from "vitest";
import { Axi, DEBUG_APK, PKG } from "./support.js";

const axi = new Axi(import.meta.filename);

/** ActivityManager logs this once the crashed process is gone, after the crash report. */
const DIED = String.raw`Process dev\.probe \(pid \d+\) has died`;

describe("logs crash", () => {
  beforeAll(async () => {
    await axi.ok(["app", "install", DEBUG_APK, "--clean-data"]);
  });

  test("a Java crash counts exactly once, and zero after the next mark", async () => {
    await axi.ok(["app", "start", PKG, "--fresh"]);
    await axi.mark("before-crash");
    await axi.probe("crash");
    await axi.waitLog(DIED, "before-crash");

    const { count, crash } = await axi.crashes("before-crash");
    expect(count).toBe(1);
    expect(crash).toMatchObject({
      kind: "java",
      process: PKG,
      exception: "java.lang.IllegalStateException",
      message: "probe crash requested",
    });

    await axi.mark("after-crash");
    expect((await axi.crashes("after-crash")).count).toBe(0);
  });

  test("a native crash is reported from its tombstone", async () => {
    await axi.ok(["app", "stop", PKG]);
    await axi.mark("before-native");
    await axi.probe("native");
    await axi.waitLog(DIED, "before-native");

    const { count, crash } = await axi.crashes("before-native");
    expect(count).toBe(1);
    expect(crash).toMatchObject({ kind: "native", process: PKG, exception: "SIGSEGV" });
  });

  test("an ANR is reported, and its report is in the system buffer", async () => {
    await axi.ok(["app", "start", PKG, "--fresh"]);
    const since = await axi.mark("before-anr");
    await axi.probe("anr");
    await axi.waitLog("event=anr blocking", "before-anr");
    // Input sent while the main thread is blocked times out into the ANR (about 5 to 15 s).
    await axi.ok(["shell", "input keyevent KEYCODE_DPAD_DOWN", "--timeout", "60s"]);
    await axi.waitLog(String.raw`ANR in dev\.probe`, "before-anr", "60s");

    const { count, crash } = await axi.crashes("before-anr");
    expect(count).toBe(1);
    expect(crash).toMatchObject({ kind: "anr", process: PKG });

    const system = await axi.ok([
      "shell",
      `logcat -d -b system -v epoch -m 1 -T '${since}' -e 'ANR in dev\\.probe'`,
    ]);
    expect(String(system.stdout)).toContain("ActivityManager: ANR in dev.probe");

    await axi.ok(["app", "stop", PKG]);
  });
});
