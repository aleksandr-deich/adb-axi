import { readFileSync, statSync } from "node:fs";
import { beforeEach, describe, expect, test } from "vitest";
import { Axi, DEBUG_APK, PKG, hideErrorDialogs } from "./support.js";

const axi = new Axi(import.meta.filename);

/** ActivityManager logs this once the crashed process is gone, after the crash report. */
const DIED = String.raw`Process dev\.probe \(pid \d+\) has died`;

hideErrorDialogs(axi);

/** Run `logs crash --pkg PKG --full` and return the file it wrote. */
async function fullFile(args: string[]): Promise<string> {
  const run = await axi.ok(["logs", "crash", "--pkg", PKG, ...args, "--full"]);
  return readFileSync(String(run.full), "utf8");
}

/** Start the probe, send it one crashing action, and wait until its process is gone. */
async function crashOnce(action: string): Promise<void> {
  const mark = `crash-${Date.now()}`;
  await axi.ok(["app", "start", PKG]);
  await axi.mark(mark);
  await axi.probe(action);
  await axi.waitLog(DIED, mark);
}

describe("logs crash", () => {
  beforeEach(async () => {
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
    await axi.ok(["app", "start", PKG, "--fresh"]);
    await axi.mark("before-native");
    await axi.probe("native");
    await axi.waitLog(DIED, "before-native");

    const { count, crash } = await axi.crashes("before-native");
    expect(count).toBe(1);
    expect(crash).toMatchObject({ kind: "native", process: PKG, exception: "SIGSEGV" });
    const tombstone = await fullFile(["--since", "before-native"]);
    expect(tombstone).toMatch(new RegExp(`>>> ${PKG.replace(".", "\\.")} <<<`));
    expect(tombstone).toContain("signal 11 (SIGSEGV)");
  });

  test("an ANR is reported, and its report is in the system buffer", async () => {
    await axi.ok(["app", "start", PKG, "--fresh"]);
    await axi.waitFocused((component) => component === `${PKG}/.MainActivity`);
    const focusDeadline = Date.now() + 30_000;
    for (;;) {
      const focus = await axi.ok(["shell", "dumpsys window | grep mCurrentFocus= || true"]);
      if (String(focus.stdout).includes(`${PKG}/`)) break;
      expect(Date.now(), String(focus.stdout)).toBeLessThan(focusDeadline);
    }
    await axi.ok([
      "shell",
      "dumpsys input | grep -A 2 -E 'Focused|DispatchEnabled|DispatchFrozen|WaitQueue|OutboundQueue'",
    ]);
    const since = await axi.mark("before-anr");
    await axi.probe("anr");
    await axi.waitLog("event=anr blocking", "before-anr");
    // Input sent while the main thread is blocked times out into the ANR (about 5 to 15 s).
    await axi.ok([
      "shell",
      "input keyboard -d 0 keyevent KEYCODE_DPAD_DOWN & input keyboard -d 0 keyevent KEYCODE_DPAD_UP; wait",
      "--timeout",
      "60s",
    ]);
    await axi.ok([
      "shell",
      "dumpsys input | grep -A 2 -E 'Focused|DispatchEnabled|DispatchFrozen|WaitQueue|OutboundQueue'",
    ]);
    await axi.waitLog(String.raw`ANR in dev\.probe`, "before-anr", "60s");

    const { count, crash } = await axi.crashes("before-anr");
    expect(count).toBe(1);
    expect(crash).toMatchObject({ kind: "anr", process: PKG });
    const report = await fullFile(["--since", "before-anr"]);
    expect(report).toContain(`ANR in ${PKG}`);
    expect(report).toMatch(/Reason: /);

    const system = await axi.ok([
      "shell",
      `logcat -d -b system -v epoch -m 1 -T '${since}' -e 'ANR in dev\\.probe'`,
    ]);
    expect(String(system.stdout)).toContain("ActivityManager: ANR in dev.probe");

    await axi.ok(["app", "stop", PKG]);
  });
});

describe("logs crash on real crash output", () => {
  test("a wrapped crash names its root cause, cuts a long message, and shares a table with a native crash", async () => {
    await axi.mark("mixed");
    await crashOnce("crashchain");
    await crashOnce("native");
    const json = await axi.ok(["logs", "crash", "--since", "mixed"]);
    expect(String(json.crashes)).toMatch(/^2 since mixed \(\d+ s, \d+ lines scanned\)$/);
    const root = `probe root cause ${"r".repeat(600)}`;
    expect(json.crash).toEqual([
      {
        kind: "java",
        at: expect.any(String) as string,
        process: PKG,
        exception: "java.lang.RuntimeException",
        message: "probe outer failure",
        cause: "java.lang.IllegalStateException",
        cause_message: `${root.slice(0, 500)}... (truncated, ${root.length} chars total)`,
        app_frame: expect.stringMatching(
          /^dev\.probe\.MainActivity\.dispatch\(MainActivity\.kt:\d+\)$/,
        ) as string,
        frames: expect.any(Number) as number,
      },
      expect.objectContaining({
        kind: "native",
        process: PKG,
        exception: "SIGSEGV",
        cause: "-",
        cause_message: "-",
      }),
    ]);
    const text = await axi.text(["logs", "crash", "--since", "mixed"]);
    expect(text.stdout).toContain(
      "crash[2]{kind,at,process,exception,message,cause,cause_message,app_frame,frames}:",
    );
    expect({ ...text.data, crashes: "-" }).toEqual({ ...json, crashes: "-" });
    const trace = await fullFile(["--since", "mixed"]);
    expect(trace).toContain(root);
    expect(trace).toContain("Caused by: java.lang.IllegalArgumentException: probe middle failure");
    expect(trace).toContain("signal 11 (SIGSEGV)");
  });

  test("a crash loop shows five and counts six, --full keeps every trace, and no crash still writes a file", async () => {
    await axi.mark("empty");
    const empty = await axi.ok(["logs", "crash", "--pkg", PKG, "--since", "empty", "--full"]);
    expect(String(empty.crashes)).toMatch(/^0 since empty /);
    expect(statSync(String(empty.full)).size).toBe(0);

    await axi.mark("loop");
    for (let i = 0; i < 6; i++) await crashOnce("crash");
    const loop = await axi.ok(["logs", "crash", "--pkg", PKG, "--since", "loop"]);
    expect(String(loop.crashes)).toMatch(/^6 since loop /);
    expect(loop.crash).toHaveLength(5);
    expect(loop.shown).toBe("5 of 6 crashes");
    expect(loop.help).toEqual([
      "Run the same command with `--full` to write the whole trace to a file",
    ]);

    const args = ["logs", "crash", "--pkg", PKG, "--since", "loop", "--full"];
    const runs = await Promise.all([axi.ok(args), axi.ok(args)]);
    expect(runs[0].full).not.toBe(runs[1].full);
    for (const run of runs) {
      const trace = readFileSync(String(run.full), "utf8");
      expect(trace.match(/FATAL EXCEPTION/g)).toHaveLength(6);
      expect(trace.match(/IllegalStateException: probe crash requested/g)).toHaveLength(6);
    }
  });
});
