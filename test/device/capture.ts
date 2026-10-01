/**
 * Real-output capture (E0). Runs the adb commands adb-axi reads, plus the probe app's
 * actions, on real emulators and saves the raw output under
 * `test/fixtures/captured/<api>/`, so parsers and fake-adb scenarios are built on what
 * devices actually print instead of on memory.
 *
 *   npm run capture -- --serial emulator-5554 --serial emulator-5556
 *
 * Every device is named explicitly: the script never falls back to a default device, and
 * it changes the devices it touches (installs and uninstalls dev.probe, clears logcat,
 * presses HOME, crashes the probe). Only run it on emulators reserved for the capture.
 *
 * Each command's stdout is saved byte for byte in its own file. `index.json` beside them
 * records, for every file, the argv, exit code, stderr and duration, and `observations`
 * records the facts later slices build on (how "cached" shows up, which buffer carries
 * the ANR report, whether `am kill` worked).
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { locateAdb } from "../../src/adb/locate.js";
import { exec } from "../../src/core/exec.js";
import { poll } from "../../src/core/poll.js";

const ROOT = resolve(import.meta.dirname, "..", "..");
const CAPTURED_DIR = join(ROOT, "test", "fixtures", "captured");
const APK_DIR = join(ROOT, "test", "fixtures", "apk");
const DEBUG_APK = join(APK_DIR, "probe-debug.apk");
const RELEASE_APK = join(APK_DIR, "probe-release.apk");

const PKG = "dev.probe";
const ACTIVITY = `${PKG}/.MainActivity`;
const MISSING_PKG = "dev.probe.missing";

/** The exact command string `src/device/facts.ts` sends, so its parser reads real output. */
const FACTS_SCRIPT = [
  "echo @sdk",
  "getprop ro.build.version.sdk",
  "echo @boot_completed",
  "getprop sys.boot_completed",
  "echo @boot_id",
  "cat /proc/sys/kernel/random/boot_id",
  "echo @size",
  "wm size",
  "echo @density",
  "wm density",
].join("; ");

/** How long to watch a backgrounded app for the "cached" state before giving up. */
const CACHED_WATCH_MS = 90_000;

interface Run {
  argv: string[];
  stdout: Buffer;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
}

interface Capture {
  file: string;
  argv: string[];
  exitCode: number | null;
  stderr: string;
  durationMs: number;
  note: string;
  /** True when host details were masked in the saved stdout (see `redact`). */
  redacted?: true;
}

const adb = locateAdb();

async function run(args: string[], deadlineMs = 30_000): Promise<Run> {
  const result = await exec({ file: adb, args, deadlineMs });
  if (result.kind === "spawn-error") throw result.error;
  if (result.kind === "timeout") {
    throw new Error(`adb ${args.join(" ")} passed its ${deadlineMs} ms deadline`);
  }
  return {
    argv: ["adb", ...args],
    stdout: result.stdout,
    stderr: result.stderr.toString("utf8"),
    exitCode: result.exitCode,
    durationMs: result.durationMs,
  };
}

/**
 * The repository is public, so host details never land in a capture: the emulator's copy
 * of the host adb key (whose comment is the user name), the home directory and the user
 * name. Binary captures are kept as they are.
 */
function redact(text: string): string {
  return text
    .replace(/(\[ro\.boot\.qemu\.adb\.pubkey\]: \[)[^\]]*\]/g, "$1<redacted>]")
    .replaceAll(homedir(), "~")
    .replaceAll(userInfo().username, "<user>");
}

/** Saves stdout byte for byte (text with host details masked) and records the call. */
class Recorder {
  readonly captures: Capture[] = [];
  readonly observations: Record<string, unknown> = {};

  constructor(readonly dir: string) {}

  async capture(file: string, args: string[], note: string, deadlineMs?: number): Promise<Run> {
    if (this.captures.some((c) => c.file === file)) throw new Error(`${file} captured twice`);
    const result = await run(args, deadlineMs);
    const raw = result.stdout.toString("utf8");
    const masked = file.endsWith(".bin") ? raw : redact(raw);
    writeFileSync(join(this.dir, file), masked === raw ? result.stdout : masked);
    this.captures.push({
      file,
      // Repository paths are recorded relative to the repository root.
      argv: result.argv.map((arg) => arg.replace(`${ROOT}/`, "")),
      exitCode: result.exitCode,
      stderr: result.stderr,
      durationMs: result.durationMs,
      note,
      ...(masked === raw ? {} : { redacted: true as const }),
    });
    console.log(`  ${file} (exit ${result.exitCode}, ${result.durationMs} ms)`);
    return result;
  }
}

/** One device's view: every call carries `-s <serial>`. */
class Device {
  constructor(readonly serial: string) {}

  args(rest: string[]): string[] {
    return ["-s", this.serial, ...rest];
  }

  async shell(command: string, deadlineMs?: number): Promise<Run> {
    return run(this.args(["shell", command]), deadlineMs);
  }

  async text(command: string): Promise<string> {
    return (await this.shell(command)).stdout.toString("utf8");
  }

  /** Device wall clock in seconds with milliseconds, the form `logcat -T` accepts. */
  async clock(): Promise<string> {
    const out = (await this.text("date +%s.%N")).trim();
    const [sec, frac = "0"] = out.split(".");
    return `${sec ?? ""}.${frac.padEnd(3, "0").slice(0, 3)}`;
  }

  async pid(): Promise<string | null> {
    const out = (await this.text(`pidof ${PKG}`)).trim();
    return out === "" ? null : out;
  }

  /** The probe's line in `dumpsys activity lru`, or null when it has no process. */
  async lruLine(): Promise<string | null> {
    const out = await this.text("dumpsys activity lru");
    const line = out.split("\n").find((l) => l.includes(`:${PKG}/`));
    return line === undefined ? null : line.trim().replace(/\s+/g, " ");
  }
}

async function waitFor<T>(
  what: string,
  timeoutMs: number,
  check: () => Promise<T | null>,
): Promise<{ value: T; waitedMs: number }> {
  const result = await poll<T, null>({
    timeoutMs,
    check: async () => {
      const value = await check();
      return value === null ? { done: false, last: null } : { done: true, value };
    },
  });
  if (!result.ok) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
  return { value: result.value, waitedMs: result.waitedMs };
}

/** Waits for a `ProbeState` oracle line matching `pattern` logged at or after `since`. */
async function waitForOracle(device: Device, since: string, pattern: RegExp): Promise<string> {
  const { value } = await waitFor(`ProbeState ${String(pattern)}`, 20_000, async () => {
    const out = await device.text(`logcat -d -v epoch -T ${since} -s ProbeState`);
    return out.split("\n").find((line) => pattern.test(line)) ?? null;
  });
  return value.trim();
}

/** Waits until logcat (all buffers, since `since`) shows every pattern. */
async function waitForLog(
  device: Device,
  since: string,
  what: string,
  patterns: RegExp[],
  timeoutMs = 30_000,
): Promise<number> {
  const { waitedMs } = await waitFor(what, timeoutMs, async () => {
    const out = await device.text(`logcat -d -b all -v epoch -T ${since}`);
    return patterns.every((p) => p.test(out)) ? true : null;
  });
  return waitedMs;
}

/** Waits until the probe is the previous app (or already cached) after HOME. */
async function waitForPrevious(device: Device): Promise<{ value: string; waitedMs: number }> {
  return waitFor("the probe to become the previous app", 10_000, async () => {
    const line = await device.lruLine();
    return line !== null && / (prev|cch) /.test(line) ? line : null;
  });
}

/** `am kill` with the probe in the background, then waits for its pid to go. */
async function killInBackground(
  rec: Recorder,
  device: Device,
  state: string,
  suffix: string,
): Promise<Record<string, unknown>> {
  const pidBefore = await device.pid();
  await rec.capture(
    `am-kill-${suffix}.txt`,
    device.args(["shell", `am kill ${PKG}`]),
    `am kill with the probe ${state}`,
  );
  const killed = await poll<true, string | null>({
    timeoutMs: 5_000,
    check: async () => {
      const pid = await device.pid();
      return pid === null ? { done: true, value: true } : { done: false, last: pid };
    },
  });
  await rec.capture(
    `pidof-after-kill-${suffix}.txt`,
    device.args(["shell", `pidof ${PKG}`]),
    "empty when the kill worked",
  );
  return { state, pidBefore, killed: killed.ok, waitedMs: killed.waitedMs };
}

async function captureDevice(serial: string): Promise<void> {
  const device = new Device(serial);
  const sdk = (await device.text("getprop ro.build.version.sdk")).trim();
  if (!/^\d+$/.test(sdk)) throw new Error(`${serial}: could not read the API level (${sdk})`);
  const dir = join(CAPTURED_DIR, sdk);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const rec = new Recorder(dir);
  const d = (rest: string[]): string[] => device.args(rest);
  const sh = (command: string): string[] => d(["shell", command]);
  console.log(`${serial}: API ${sdk} -> ${dir}`);

  // Device facts.
  await rec.capture("emu-avd-name.txt", d(["emu", "avd", "name"]), "AVD name; CRLF, then OK");
  await rec.capture("getprop.txt", sh("getprop"), "every system property");
  await rec.capture("wm-size.txt", sh("wm size"), "physical display size");
  await rec.capture("wm-density.txt", sh("wm density"), "physical density");
  await rec.capture("facts-script.txt", sh(FACTS_SCRIPT), "the src/device/facts.ts shell call");
  await rec.capture("date-epoch.txt", sh("date +%s.%N"), "device wall clock, s.ns");
  await rec.capture("proc-uptime.txt", sh("cat /proc/uptime"), "device uptime, s");

  // A device without the probe.
  await device.shell(`pm uninstall ${PKG}`);
  await rec.capture(
    "uninstall-missing.txt",
    d(["uninstall", PKG]),
    "L7: uninstall of a package that is not installed",
  );
  await rec.capture(
    "pm-list-packages-absent.txt",
    sh(`pm list packages ${PKG}`),
    "filter matching nothing",
  );
  await rec.capture(
    "dumpsys-package-absent.txt",
    sh(`dumpsys package ${MISSING_PKG}`),
    "package not installed",
  );
  await rec.capture("pidof-not-running.txt", sh(`pidof ${PKG}`), "no process");

  // Install the debuggable build and read the package manager.
  await rec.capture(
    "install-debug.txt",
    d(["install", "-r", DEBUG_APK]),
    "adb install -r, debuggable build",
    180_000,
  );
  await rec.capture("pm-list-packages.txt", sh("pm list packages"), "every package");
  await rec.capture("pm-list-packages-3.txt", sh("pm list packages -3"), "third-party packages");
  await rec.capture(
    "pm-list-packages-probe.txt",
    sh(`pm list packages ${PKG}`),
    "filter by name (substring)",
  );
  const uidRun = await rec.capture(
    "pm-list-packages-uid.txt",
    sh(`pm list packages -U ${PKG}`),
    "with uid",
  );
  await rec.capture(
    "pm-list-packages-versioncode.txt",
    sh(`pm list packages --show-versioncode ${PKG}`),
    "with versionCode",
  );
  await rec.capture("pm-path.txt", sh(`pm path ${PKG}`), "installed APK paths");
  await rec.capture(
    "dumpsys-package-debug.txt",
    sh(`dumpsys package ${PKG}`),
    "debuggable build installed",
  );
  const uid = /uid:(\d+)/.exec(uidRun.stdout.toString("utf8"))?.[1];
  if (uid === undefined) throw new Error(`${serial}: no uid in pm list packages -U`);

  await device.shell("logcat -c");
  const startMark = await device.clock();
  rec.observations.logcatClearedAt = startMark;

  // Cold start, then actions delivered to the activity on top.
  await device.shell(`am force-stop ${PKG}`);
  await rec.capture(
    "am-start-cold.txt",
    sh(`am start -W -n ${ACTIVITY}`),
    "cold start: no process",
  );
  await waitForOracle(device, startMark, /event=start /);
  await rec.capture("pidof-running.txt", sh(`pidof ${PKG}`), "one process");
  await rec.capture(
    "am-start-delivered-to-top.txt",
    sh(`am start -W -n ${ACTIVITY} --es probe inc`),
    "singleTop activity already on top: the intent goes to onNewIntent",
  );
  await device.shell(`am start -n ${ACTIVITY} --es probe inc`);
  await device.shell(`am start -n ${ACTIVITY} --es probe inc`);
  rec.observations.afterIncrements = await waitForOracle(device, startMark, /event=inc saved=3 /);

  // A write that stays in the WAL.
  await device.shell(`am start -n ${ACTIVITY} --es probe write`);
  rec.observations.afterWrite = await waitForOracle(device, startMark, /event=write .*rows=1 /);
  await rec.capture("run-as-ls-databases.txt", sh(`run-as ${PKG} ls databases`), "file names");
  await rec.capture(
    "run-as-ls-l-databases.txt",
    sh(`run-as ${PKG} ls -l databases`),
    "with sizes; the row is only in -wal",
  );
  await rec.capture(
    "exec-out-probe-db.bin",
    d(["exec-out", "run-as", PKG, "cat", "databases/probe.db"]),
    "main file bytes, header page only",
  );
  await rec.capture(
    "exec-out-probe-db-wal.bin",
    d(["exec-out", "run-as", PKG, "cat", "databases/probe.db-wal"]),
    "WAL bytes holding the row",
  );
  await rec.capture(
    "exec-out-missing-db.bin",
    d(["exec-out", "run-as", PKG, "cat", "databases/missing.db"]),
    "S1: error text as the bytes",
  );

  // The app in front.
  await rec.capture(
    "dumpsys-activity-activities-probe-front.txt",
    sh("dumpsys activity activities"),
    "probe resumed",
  );
  await rec.capture(
    "dumpsys-activity-recents-probe-front.txt",
    sh("dumpsys activity recents"),
    "probe task on top",
  );
  await rec.capture(
    "dumpsys-activity-lru-probe-front.txt",
    sh("dumpsys activity lru"),
    "probe fg TOP",
  );
  await rec.capture(
    "dumpsys-activity-processes-probe-front.txt",
    sh(`dumpsys activity processes ${PKG}`),
    "probe process record, foreground",
  );

  // S5, L5: am kill does nothing to a foreground app.
  const pidFront = await device.pid();
  await rec.capture(
    "am-kill-foreground.txt",
    sh(`am kill ${PKG}`),
    "S5: no-op on a foreground app",
  );
  await rec.capture(
    "pidof-after-kill-foreground.txt",
    sh(`pidof ${PKG}`),
    "same pid: still running",
  );
  rec.observations.amKillForeground = { pidBefore: pidFront, pidAfter: await device.pid() };

  // HOME: the probe becomes the previous app.
  await device.shell("input keyevent KEYCODE_HOME");
  const previous = await waitForPrevious(device);
  rec.observations.afterHome = { lru: previous.value, waitedMs: previous.waitedMs };
  await rec.capture(
    "dumpsys-activity-activities-launcher-front.txt",
    sh("dumpsys activity activities"),
    "launcher resumed, probe stopped",
  );
  await rec.capture(
    "dumpsys-activity-lru-previous.txt",
    sh("dumpsys activity lru"),
    "probe as the previous app",
  );
  await rec.capture(
    "dumpsys-activity-processes-probe-previous.txt",
    sh(`dumpsys activity processes ${PKG}`),
    "probe process record, previous app",
  );

  // Hot start: process and activity both alive.
  await rec.capture(
    "am-start-hot.txt",
    sh(`am start -W -n ${ACTIVITY}`),
    "hot start from the background",
  );

  // How "cached" shows up: watch the probe after HOME until it is cached or the watch ends.
  await device.shell("input keyevent KEYCODE_HOME");
  const timeline: { atMs: number; lru: string | null }[] = [];
  const stateOf = (line: string | null): string | null =>
    line?.split(" ").slice(1, 3).join(" ") ?? null;
  const watchStart = performance.now();
  const cached = await poll<string, string | null>({
    timeoutMs: CACHED_WATCH_MS,
    intervalMs: 500,
    check: async () => {
      const line = await device.lruLine();
      const last = timeline.at(-1);
      if (last === undefined || stateOf(last.lru) !== stateOf(line)) {
        timeline.push({ atMs: Math.round(performance.now() - watchStart), lru: line });
      }
      return line?.includes(" cch ") === true
        ? { done: true, value: line }
        : { done: false, last: line };
    },
  });
  rec.observations.cachedWatch = {
    watchedMs: cached.waitedMs,
    cachedAfterMs: cached.ok ? cached.waitedMs : null,
    timeline,
  };
  const label = cached.ok ? "cached" : "previous-after-watch";
  await rec.capture(
    `dumpsys-activity-lru-${label}.txt`,
    sh("dumpsys activity lru"),
    `probe state after the ${CACHED_WATCH_MS / 1000} s watch`,
  );
  await rec.capture(
    `dumpsys-activity-processes-probe-${label}.txt`,
    sh(`dumpsys activity processes ${PKG}`),
    "probe process record after the watch",
  );

  // am kill in the background, then restore through the task: the saved counter
  // survives, the volatile one resets.
  rec.observations.amKillAfterWatch = await killInBackground(rec, device, label, "after-watch");
  await rec.capture(
    "dumpsys-activity-recents-after-kill.txt",
    sh("dumpsys activity recents"),
    "probe task kept, no process",
  );
  await rec.capture(
    "dumpsys-activity-activities-after-kill.txt",
    sh("dumpsys activity activities"),
    "probe activity record kept, no process",
  );
  const restoreMark = await device.clock();
  await rec.capture(
    "am-start-restore-after-kill.txt",
    sh(`am start -W -n ${ACTIVITY}`),
    "task to front, new process",
  );
  rec.observations.afterRestore = await waitForOracle(
    device,
    restoreMark,
    /event=start .*restored=true /,
  );

  // am kill on the previous app, before it is cached.
  await device.shell("input keyevent KEYCODE_HOME");
  const previousAgain = await waitForPrevious(device);
  rec.observations.amKillPrevious = {
    lru: previousAgain.value,
    ...(await killInBackground(rec, device, "previous", "previous")),
  };
  const secondRestoreMark = await device.clock();
  await device.shell(`am start -W -n ${ACTIVITY}`);
  rec.observations.afterSecondRestore = await waitForOracle(
    device,
    secondRestoreMark,
    /event=start .*restored=true /,
  );

  // Warm start: the process lives on without its activity.
  const finishMark = await device.clock();
  await device.shell(`am start -n ${ACTIVITY} --es probe finish`);
  await waitForOracle(device, finishMark, /event=finish /);
  await waitFor("the activity to be destroyed", 10_000, async () => {
    const line = await device.lruLine();
    return line !== null && !line.includes("act:activities") ? line : null;
  });
  await rec.capture(
    "dumpsys-activity-lru-no-activity.txt",
    sh("dumpsys activity lru"),
    "process alive, no activity",
  );
  await rec.capture(
    "am-start-warm.txt",
    sh(`am start -W -n ${ACTIVITY}`),
    "warm start: process alive, activity created",
  );
  await waitForOracle(device, finishMark, /event=start .*restored=false /);
  await rec.capture(
    "logcat-probestate.txt",
    sh("logcat -d -v epoch -s ProbeState"),
    "the oracle across the whole run",
  );

  // Start errors.
  await rec.capture(
    "am-start-missing-activity.txt",
    sh(`am start -W -n ${PKG}/.Missing`),
    "activity does not exist",
  );
  await rec.capture(
    "am-start-missing-package.txt",
    sh(`am start -W -n ${MISSING_PKG}/.MainActivity`),
    "package does not exist",
  );

  // Logcat dumps over the run so far.
  await rec.capture(
    "logcat-epoch.txt",
    sh("logcat -d -v epoch"),
    "default buffers since the clear",
    60_000,
  );
  await rec.capture(
    "logcat-epoch-uid.txt",
    sh(`logcat -d -v epoch --uid ${uid}`),
    "only the probe's uid",
    60_000,
  );
  await rec.capture(
    "logcat-epoch-since.txt",
    sh(`logcat -d -v epoch -T ${restoreMark}`),
    "since a device-clock mark",
    60_000,
  );

  // pm clear.
  await rec.capture("pm-clear.txt", sh(`pm clear ${PKG}`), "clears data and stops the app");
  await rec.capture("pidof-after-clear.txt", sh(`pidof ${PKG}`), "no process after clear");

  // Java crash, delivered to the running activity.
  await device.shell(`am start -W -n ${ACTIVITY}`);
  const javaMark = await device.clock();
  await device.shell(`am start -n ${ACTIVITY} --es probe crash`);
  rec.observations.javaCrashWaitMs = await waitForLog(device, javaMark, "the Java crash", [
    /FATAL EXCEPTION/,
    /probe crash requested/,
  ]);
  await rec.capture(
    "logcat-crash-java.txt",
    sh(`logcat -d -v epoch -b crash -T ${javaMark}`),
    "crash buffer: a Java crash",
  );
  await rec.capture(
    "logcat-all-java-crash.txt",
    sh(`logcat -d -v epoch -b all -T ${javaMark}`),
    "all buffers around the Java crash",
  );
  await device.shell(`am force-stop ${PKG}`);

  // Native crash: SIGSEGV from onCreate.
  const nativeMark = await device.clock();
  await device.shell(`am start -n ${ACTIVITY} --es probe native`);
  rec.observations.nativeCrashWaitMs = await waitForLog(
    device,
    nativeMark,
    "the native crash tombstone",
    [/Fatal signal 11/, /\*\*\* \*\*\* \*\*\*/, /Tombstone written|backtrace:/],
  );
  await rec.capture(
    "logcat-crash-native.txt",
    sh(`logcat -d -v epoch -b crash -T ${nativeMark}`),
    "crash buffer: a native crash",
  );
  await rec.capture(
    "logcat-all-native-crash.txt",
    sh(`logcat -d -v epoch -b all -T ${nativeMark}`),
    "all buffers around the native crash",
  );
  await device.shell(`am force-stop ${PKG}`);

  // ANR: block the main thread, then send input to the focused window.
  const anrMark = await device.clock();
  await device.shell(`am start -W -n ${ACTIVITY}`);
  await waitForOracle(device, anrMark, /event=start /);
  await device.shell(`am start -n ${ACTIVITY} --es probe anr`);
  await waitForOracle(device, anrMark, /event=anr blocking/);
  const input = await device.shell("input keyevent KEYCODE_DPAD_DOWN", 45_000);
  rec.observations.anrInputMs = input.durationMs;
  rec.observations.anrWaitMs = await waitForLog(
    device,
    anrMark,
    "the ANR report",
    [/ANR in dev\.probe/],
    45_000,
  );
  const anrBuffers: Record<string, Record<string, boolean>> = {};
  for (const buffer of ["main", "system", "events", "crash"]) {
    const result = await rec.capture(
      `logcat-anr-${buffer}.txt`,
      sh(`logcat -d -v epoch -b ${buffer} -T ${anrMark}`),
      `${buffer} buffer around the ANR`,
    );
    const text = result.stdout.toString("utf8");
    anrBuffers[buffer] = {
      "ANR in dev.probe": text.includes("ANR in dev.probe"),
      am_anr: /\bam_anr\b/.test(text),
      "Input dispatching timed out": text.includes("Input dispatching timed out"),
    };
  }
  rec.observations.anrBuffers = anrBuffers;
  await device.shell(`am force-stop ${PKG}`);

  // The non-debuggable build.
  await rec.capture(
    "install-release.txt",
    d(["install", "-r", RELEASE_APK]),
    "release build over the debug one",
    180_000,
  );
  await rec.capture(
    "dumpsys-package-release.txt",
    sh(`dumpsys package ${PKG}`),
    "non-debuggable build installed",
  );
  await rec.capture(
    "run-as-release.txt",
    sh(`run-as ${PKG} ls databases`),
    "run-as refused: not debuggable",
  );
  await rec.capture(
    "exec-out-run-as-release.bin",
    d(["exec-out", "run-as", PKG, "cat", "databases/probe.db"]),
    "S1: refusal text as the bytes",
  );

  await rec.capture("uninstall.txt", d(["uninstall", PKG]), "uninstall of an installed package");

  const avd =
    (await run(d(["emu", "avd", "name"]))).stdout.toString("utf8").split(/\r?\n/)[0] ?? "";
  const index = {
    api: Number(sdk),
    serial,
    avd,
    capturedAt: new Date().toISOString(),
    probe: { package: PKG, activity: ACTIVITY, uid: Number(uid) },
    observations: rec.observations,
    captures: rec.captures,
  };
  writeFileSync(join(dir, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { serial: { type: "string", multiple: true } } });
  const serials = values.serial ?? [];
  if (serials.length === 0) {
    console.error("Name every device to capture: --serial <serial> [--serial <serial> ...]");
    process.exit(2);
  }

  const hostDir = join(CAPTURED_DIR, "host");
  rmSync(hostDir, { recursive: true, force: true });
  mkdirSync(hostDir, { recursive: true });
  const host = new Recorder(hostDir);
  await host.capture("adb-version.txt", ["version"], "adb client version");
  await host.capture("devices-l.txt", ["devices", "-l"], "every attached device, long form");
  writeFileSync(
    join(hostDir, "index.json"),
    `${JSON.stringify({ capturedAt: new Date().toISOString(), captures: host.captures }, null, 2)}\n`,
  );

  for (const serial of serials) await captureDevice(serial);
}

await main();
