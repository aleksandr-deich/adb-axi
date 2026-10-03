import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { crashBelongsTo, parseCrashes, type Crash } from "../../src/android/crash.js";
import { parseLogcat, type LogLine } from "../../src/android/logcat.js";
import { FIXTURES_DIR } from "../fake-adb/harness.js";

/** Real output recorded by E0 on the API 35 tablet and the API 37 phone. */
function captured(api: "35" | "37", file: string): LogLine[] {
  return parseLogcat(readFileSync(join(FIXTURES_DIR, "captured", api, file), "utf8")).lines;
}

const APIS = ["35", "37"] as const;

/** A synthetic log line: `epochMs` offsets from a fixed second, pid doubling as tid. */
function line(ms: number, pid: number, level: string, tag: string, message: string): LogLine {
  return {
    epochMs: 1790834000000 + ms,
    time: "",
    pid,
    tid: pid,
    level: level as LogLine["level"],
    tag,
    message,
    buffer: null,
  };
}

/** The one crash a window holds. */
function one(lines: readonly LogLine[]): Crash {
  const crashes = parseCrashes(lines);
  if (crashes.length !== 1) throw new Error(`expected one crash, found ${crashes.length}`);
  return crashes[0] as Crash;
}

const runtime = (ms: number, pid: number, message: string): LogLine =>
  line(ms, pid, "E", "AndroidRuntime", message);

describe("parseCrashes on captured output", () => {
  it.each(APIS)("reads the Java crash of API %s from the crash buffer", (api) => {
    const crash = one(captured(api, "logcat-crash-java.txt"));
    expect(crash).toMatchObject({
      kind: "java",
      process: "dev.probe",
      exception: "java.lang.IllegalStateException",
      message: "probe crash requested",
      appFrame: "dev.probe.MainActivity.dispatch(MainActivity.kt:67)",
    });
    // The pid in the `Process:` line is the pid that printed the block.
    expect(crash.pid).toBe(captured(api, "logcat-crash-java.txt")[0]?.pid);
    // Every `at` line counts; the frames are the block minus FATAL, Process and the header.
    expect(crash.frames).toBe(crash.trace.length - 3);
    expect(crash.trace[0]).toBe("FATAL EXCEPTION: main");
    expect(crash.epochMs).toBe(captured(api, "logcat-crash-java.txt")[0]?.epochMs);
  });

  it("counts 22 frames on API 35 and 23 on API 37", () => {
    expect(parseCrashes(captured("35", "logcat-crash-java.txt"))[0]?.frames).toBe(22);
    expect(parseCrashes(captured("37", "logcat-crash-java.txt"))[0]?.frames).toBe(23);
  });

  it.each(APIS)("reads the native crash of API %s from its tombstone summary", (api) => {
    const lines = captured(api, "logcat-crash-native.txt");
    const crash = one(lines);
    expect(crash).toMatchObject({
      kind: "native",
      process: "dev.probe",
      exception: "SIGSEGV",
      message: "signal 11 (SIGSEGV), code 0 (SI_USER), fault addr --------",
      appFrame: "dev.probe.MainActivity.dispatch+0 (base.apk)",
    });
    // The crashing process's own line is a moment older than crash_dump's summary, and is the time.
    const raised = lines.find((l) => l.tag === "libc");
    const summary = lines.find((l) => l.tag === "DEBUG");
    expect(raised).toBeDefined();
    expect(summary?.epochMs).toBeGreaterThan(raised?.epochMs ?? 0);
    expect(crash.epochMs).toBe(raised?.epochMs);
    // The pid is the crashing process (libc's line), not crash_dump's own.
    expect(crash.pid).toBe(raised?.pid);
    expect(crash.pid).not.toBe(summary?.pid);
    expect(crash.frames).toBe(lines.filter((l) => /^\s+#\d+ pc /.test(l.message)).length);
    expect(crash.frames).toBeGreaterThan(80);
  });

  it.each(APIS)("reads the ANR of API %s from the system buffer", (api) => {
    const lines = captured(api, "logcat-anr-system.txt");
    const crash = one(lines);
    expect(crash).toMatchObject({
      kind: "anr",
      process: "dev.probe",
      exception: "ANR",
      appFrame: null,
      frames: 0,
    });
    expect(crash.message).toMatch(
      /^Input dispatching timed out \(\w+ dev\.probe\/dev\.probe\.MainActivity/,
    );
    // The report is printed by system_server (another uid and pid); the PID line names the app.
    const start = lines.find((l) => l.message.startsWith("ANR in dev.probe"));
    expect(crash.epochMs).toBe(start?.epochMs);
    expect(crash.pid).not.toBe(start?.pid);
    expect(crash.pid).toBe(Number(/^PID: (\d+)/.exec(crash.trace[1] ?? "")?.[1]));
  });

  it.each(APIS)("finds no ANR in the main, crash and events buffers of API %s", (api) => {
    for (const file of ["logcat-anr-main.txt", "logcat-anr-crash.txt", "logcat-anr-events.txt"]) {
      expect(parseCrashes(captured(api, file)), file).toEqual([]);
    }
  });

  it.each(APIS)("counts each crash once in the all-buffers dumps of API %s", (api) => {
    const java = parseCrashes(captured(api, "logcat-all-java-crash.txt"));
    expect(java.map((c) => c.kind)).toEqual(["java"]);
    const native = parseCrashes(captured(api, "logcat-all-native-crash.txt"));
    expect(native.map((c) => c.kind)).toEqual(["native"]);
    expect(native[0]?.process).toBe("dev.probe");
  });

  it.each(APIS)("finds all three kinds in one window, in the order they started", (api) => {
    const window = [
      ...captured(api, "logcat-crash-java.txt"),
      ...captured(api, "logcat-crash-native.txt"),
      ...captured(api, "logcat-anr-system.txt"),
    ];
    const crashes = parseCrashes(window);
    expect(crashes.map((c) => c.kind)).toEqual(["java", "native", "anr"]);
    for (const crash of crashes) expect(crashBelongsTo(crash, "dev.probe")).toBe(true);
  });

  it("finds nothing in a window without a crash", () => {
    expect(parseCrashes(captured("35", "logcat-epoch.txt"))).toEqual([]);
    expect(parseCrashes([])).toEqual([]);
  });
});

describe("ANR report boundaries", () => {
  it("excludes later activity from the same system-server thread", () => {
    const crash = one([
      line(0, 552, "E", "ActivityManager", "ANR in dev.probe"),
      line(0, 552, "E", "ActivityManager", "PID: 123"),
      line(0, 552, "E", "ActivityManager", "Reason: first"),
      line(1, 552, "E", "ActivityManager", "PID: 999"),
      line(1, 552, "E", "ActivityManager", "Reason: unrelated"),
    ]);
    expect(crash).toMatchObject({ pid: 123, message: "first" });
    expect(crash.trace).toEqual(["ANR in dev.probe", "PID: 123", "Reason: first"]);
  });

  it("closes a report when its thread logs a different priority", () => {
    const crash = one([
      line(0, 552, "E", "ActivityManager", "ANR in dev.probe"),
      line(0, 552, "D", "ActivityManager", "Completed ANR of dev.probe"),
      line(0, 552, "E", "ActivityManager", "Reason: unrelated"),
    ]);
    expect(crash.trace).toEqual(["ANR in dev.probe"]);
  });
});

describe("matching by package name", () => {
  const probe = (process: string): Crash =>
    one([
      runtime(0, 100, "FATAL EXCEPTION: main"),
      runtime(0, 100, `Process: ${process}, PID: 100`),
      runtime(0, 100, "java.lang.IllegalStateException: boom"),
    ]);

  it("matches the main process and its <pkg>:<name> processes, not look-alike packages", () => {
    expect(crashBelongsTo(probe("dev.probe"), "dev.probe")).toBe(true);
    expect(crashBelongsTo(probe("dev.probe:remote"), "dev.probe")).toBe(true);
    expect(crashBelongsTo(probe("dev.probe2"), "dev.probe")).toBe(false);
    expect(crashBelongsTo(probe("dev.probe.debug"), "dev.probe")).toBe(false);
    expect(crashBelongsTo(probe("com.other.dev.probe"), "dev.probe")).toBe(false);
  });

  it("never matches a crash whose process is unnamed", () => {
    const crash = one([runtime(0, 100, "FATAL EXCEPTION: main")]);
    expect(crash.process).toBe("-");
    expect(crashBelongsTo(crash, "dev.probe")).toBe(false);
  });

  it("matches the ANR of an app by the name in the report, not by the pid that printed it", () => {
    const crash = one([
      line(
        0,
        552,
        "E",
        "ActivityManager",
        "ANR in com.example.notes:sync (com.example.notes/.SyncService)",
      ),
      line(0, 552, "E", "ActivityManager", "PID: 7001"),
      line(
        0,
        552,
        "E",
        "ActivityManager",
        "Reason: executing service com.example.notes/.SyncService",
      ),
    ]);
    expect(crash).toMatchObject({
      process: "com.example.notes:sync",
      pid: 7001,
      message: "executing service com.example.notes/.SyncService",
    });
    expect(crashBelongsTo(crash, "com.example.notes")).toBe(true);
    expect(crashBelongsTo(crash, "com.example")).toBe(false);
  });
});

describe("Java crash blocks", () => {
  it("joins a multi-line message, and keeps the exception class apart from it", () => {
    const crash = one([
      runtime(0, 100, "FATAL EXCEPTION: main"),
      runtime(0, 100, "Process: com.example.notes, PID: 100"),
      runtime(0, 100, "java.lang.IllegalStateException: Room cannot verify the data integrity."),
      runtime(0, 100, "Expected identity hash: abc"),
      runtime(0, 100, "Found: def"),
      runtime(
        0,
        100,
        "\tat com.example.notes.data.NoteDatabase_Impl.onValidateSchema(NoteDatabase_Impl.kt:88)",
      ),
    ]);
    expect(crash).toMatchObject({
      exception: "java.lang.IllegalStateException",
      message: "Room cannot verify the data integrity. Expected identity hash: abc Found: def",
      frames: 1,
    });
  });

  it("reads an exception without a message as an empty message", () => {
    const crash = one([
      runtime(0, 100, "FATAL EXCEPTION: main"),
      runtime(0, 100, "Process: com.example.notes, PID: 100"),
      runtime(0, 100, "java.lang.NullPointerException"),
      runtime(0, 100, "\tat com.example.notes.Main.run(Main.kt:1)"),
    ]);
    expect(crash).toMatchObject({ exception: "java.lang.NullPointerException", message: "" });
  });

  it("finds the app frame in a Caused by trace when the outer trace is all framework", () => {
    const crash = one([
      runtime(0, 100, "FATAL EXCEPTION: main"),
      runtime(0, 100, "Process: com.example.notes, PID: 100"),
      runtime(
        0,
        100,
        "java.lang.RuntimeException: Unable to start activity ComponentInfo{com.example.notes/.Main}",
      ),
      runtime(
        0,
        100,
        "\tat android.app.ActivityThread.performLaunchActivity(ActivityThread.java:3270)",
      ),
      runtime(0, 100, "\tat android.os.Looper.loop(Looper.java:193)"),
      runtime(0, 100, "Caused by: java.lang.IllegalStateException: bad state"),
      runtime(0, 100, "\tat androidx.fragment.app.Fragment.onCreate(Fragment.java:10)"),
      runtime(0, 100, "\tat com.example.notes.Main.onCreate(Main.kt:12)"),
      runtime(0, 100, "\t... 12 more"),
    ]);
    expect(crash).toMatchObject({
      exception: "java.lang.RuntimeException",
      message: "Unable to start activity ComponentInfo{com.example.notes/.Main}",
      appFrame: "com.example.notes.Main.onCreate(Main.kt:12)",
      frames: 4,
    });
  });

  it("falls back to the first frame outside the platform when the namespace differs from the package", () => {
    const crash = one([
      runtime(0, 100, "FATAL EXCEPTION: main"),
      runtime(0, 100, "Process: com.example.notes, PID: 100"),
      runtime(0, 100, "java.lang.IllegalStateException: x"),
      runtime(0, 100, "\tat java.util.Objects.requireNonNull(Objects.java:1)"),
      runtime(0, 100, "\tat kotlin.Result.getOrThrow(Result.kt:2)"),
      runtime(0, 100, "\tat org.acme.notes.Repo.load(Repo.kt:3)"),
    ]);
    expect(crash.appFrame).toBe("org.acme.notes.Repo.load(Repo.kt:3)");
  });

  it("has no app frame when every frame is the platform's", () => {
    const crash = one([
      runtime(0, 100, "FATAL EXCEPTION: main"),
      runtime(0, 100, "Process: com.example.notes, PID: 100"),
      runtime(0, 100, "java.lang.IllegalStateException: x"),
      runtime(0, 100, "\tat android.os.Looper.loop(Looper.java:1)"),
    ]);
    expect(crash).toMatchObject({ appFrame: null, frames: 1 });
  });

  it("names system_server for a crash in the system process", () => {
    const crash = one([
      runtime(0, 552, "FATAL EXCEPTION IN SYSTEM PROCESS: android.fg"),
      runtime(0, 552, "java.lang.NullPointerException: oops"),
      runtime(0, 552, "\tat com.android.server.am.Foo.bar(Foo.java:1)"),
    ]);
    expect(crash).toMatchObject({ process: "system_server", pid: 552, frames: 1 });
  });

  it("keeps two processes' blocks apart when their lines interleave", () => {
    const crashes = parseCrashes([
      runtime(0, 100, "FATAL EXCEPTION: main"),
      runtime(1, 200, "FATAL EXCEPTION: main"),
      runtime(2, 100, "Process: com.example.a, PID: 100"),
      runtime(3, 200, "Process: com.example.b, PID: 200"),
      line(3, 300, "I", "Other", "noise in between"),
      runtime(4, 100, "java.lang.IllegalStateException: a"),
      runtime(5, 200, "java.lang.IllegalArgumentException: b"),
      runtime(6, 100, "\tat com.example.a.A.run(A.kt:1)"),
      runtime(7, 200, "\tat com.example.b.B.run(B.kt:2)"),
      runtime(8, 200, "\tat com.example.b.B.go(B.kt:3)"),
    ]);
    expect(crashes.map((c) => [c.process, c.exception, c.frames])).toEqual([
      ["com.example.a", "java.lang.IllegalStateException", 1],
      ["com.example.b", "java.lang.IllegalArgumentException", 2],
    ]);
  });

  it("ends a block at the next FATAL EXCEPTION of the same pid", () => {
    const crashes = parseCrashes([
      runtime(0, 100, "FATAL EXCEPTION: main"),
      runtime(0, 100, "Process: com.example.a, PID: 100"),
      runtime(0, 100, "java.lang.IllegalStateException: first"),
      runtime(0, 100, "\tat com.example.a.A.run(A.kt:1)"),
      runtime(900, 100, "FATAL EXCEPTION: main"),
      runtime(900, 100, "Process: com.example.a, PID: 100"),
      runtime(900, 100, "java.lang.IllegalStateException: second"),
    ]);
    expect(crashes.map((c) => [c.message, c.frames])).toEqual([
      ["first", 1],
      ["second", 0],
    ]);
  });

  it("does not see a crash whose first line is before the window, only its trailing lines", () => {
    // The window opens in the middle of the block: the FATAL line was never read.
    expect(
      parseCrashes([
        runtime(0, 100, "java.lang.IllegalStateException: stale"),
        runtime(0, 100, "\tat com.example.a.A.run(A.kt:1)"),
        line(0, 552, "I", "ActivityManager", "Process com.example.a (pid 100) has died"),
      ]),
    ).toEqual([]);
  });

  it("keeps the whole block as the device printed it", () => {
    const crash = one([
      runtime(0, 100, "FATAL EXCEPTION: main"),
      runtime(0, 100, "Process: com.example.a, PID: 100"),
      runtime(0, 100, "java.lang.IllegalStateException: x"),
      runtime(0, 100, "\tat com.example.a.A.run(A.kt:1)"),
    ]);
    expect(crash.trace).toEqual([
      "FATAL EXCEPTION: main",
      "Process: com.example.a, PID: 100",
      "java.lang.IllegalStateException: x",
      "\tat com.example.a.A.run(A.kt:1)",
    ]);
  });
});

describe("native crash blocks", () => {
  const debug = (ms: number, message: string): LogLine => line(ms, 9409, "F", "DEBUG", message);

  it("reads an abort message and uses the tombstone's time when the process line is missing", () => {
    const crash = one([
      debug(500, "*** *** *** *** *** *** *** *** *** *** *** *** *** *** *** ***"),
      debug(500, "Cmdline: com.example.notes"),
      debug(500, "pid: 9386, tid: 9386, name: example.notes  >>> com.example.notes <<<"),
      debug(500, "signal 6 (SIGABRT), code -1 (SI_QUEUE), fault addr --------"),
      debug(500, "Abort message: 'Check failed: x'"),
      debug(500, "backtrace:"),
      debug(
        500,
        "      #00 pc 000000000005a3bc  /apex/com.android.runtime/lib64/bionic/libc.so (abort+168) (BuildId: 1b9fecf834d610f77e641f026ca7269b)",
      ),
      debug(
        500,
        "      #01 pc 0000000000012345  /data/app/~~x==/com.example.notes-y==/lib/arm64/libnotes.so (notes_crash+20) (BuildId: abc)",
      ),
      debug(
        500,
        "      #02 pc 0000000000023456  /data/app/~~x==/com.example.notes-y==/lib/arm64/libnotes.so",
      ),
    ]);
    expect(crash).toMatchObject({
      kind: "native",
      epochMs: 1790834000500,
      process: "com.example.notes",
      pid: 9386,
      exception: "SIGABRT",
      message:
        "signal 6 (SIGABRT), code -1 (SI_QUEUE), fault addr --------; abort message: Check failed: x",
      appFrame: "notes_crash+20 (libnotes.so)",
      frames: 3,
    });
  });

  it("does not assign an earlier process's signal to a reused pid", () => {
    const debug = (ms: number, message: string): LogLine => line(ms, 9409, "F", "DEBUG", message);
    const crashes = parseCrashes([
      line(0, 9386, "F", "libc", "Fatal signal 11 (SIGSEGV) in tid 9386 (dev.other), pid 9386 (dev.other)"),
      debug(200, "*** *** *** ***"),
      debug(200, "pid: 9386, tid: 9386, name: other  >>> dev.other <<<"),
      debug(200, "signal 11 (SIGSEGV), code 0 (SI_USER)"),
      debug(500, "*** *** *** ***"),
      debug(500, "pid: 9386, tid: 9386, name: probe  >>> dev.probe <<<"),
      debug(500, "signal 11 (SIGSEGV), code 0 (SI_USER)"),
    ]);
    expect(crashes.map((crash) => [crash.process, crash.epochMs])).toEqual([
      ["dev.other", 1790834000000],
      ["dev.probe", 1790834000500],
    ]);
  });

  it("does not pair a distant signal with a tombstone of a reused process", () => {
    const crash = one([
      line(0, 9386, "F", "libc", "Fatal signal 11 (SIGSEGV) in tid 9386 (dev.probe), pid 9386 (dev.probe)"),
      line(20_000, 9409, "F", "DEBUG", "*** *** *** ***"),
      line(20_000, 9409, "F", "DEBUG", "pid: 9386, tid: 9386, name: probe  >>> dev.probe <<<"),
      line(20_000, 9409, "F", "DEBUG", "signal 11 (SIGSEGV), code 0 (SI_USER)"),
    ]);
    expect(crash.epochMs).toBe(1790834020000);
  });

  it("names a symbol-less app frame by its file and address", () => {
    const crash = one([
      debug(0, "*** *** *** *** *** *** *** *** *** *** *** *** *** *** *** ***"),
      debug(0, "pid: 7, tid: 7, name: x  >>> com.example.notes <<<"),
      debug(0, "signal 11 (SIGSEGV), code 1 (SEGV_MAPERR), fault addr 0x0"),
      debug(
        0,
        "      #00 pc 0000000000023456  /data/app/~~x==/com.example.notes-y==/lib/arm64/libnotes.so",
      ),
    ]);
    expect(crash.appFrame).toBe("libnotes.so pc 0000000000023456");
  });

  it("reads an app frame in memory-mapped dex, whose path has spaces", () => {
    const crash = one([
      debug(0, "*** *** *** *** *** *** *** *** *** *** *** *** *** *** *** ***"),
      debug(0, "pid: 7, tid: 7, name: x  >>> com.example.notes <<<"),
      debug(0, "signal 11 (SIGSEGV), code 1 (SEGV_MAPERR), fault addr 0x0"),
      debug(
        0,
        "      #00 pc 00000000000bd428  /apex/com.android.runtime/lib64/bionic/libc.so (kill+8)",
      ),
      debug(
        0,
        "      #01 pc 00000000001b1488  [anon:dalvik-classes.dex extracted in memory from /data/app/~~x==/com.example.notes-y==/base.apk] (com.example.notes.Main.run+0)",
      ),
    ]);
    expect(crash).toMatchObject({
      frames: 2,
      appFrame: "com.example.notes.Main.run+0 (base.apk)",
    });
  });

  it("has no app frame when the backtrace stays in the system", () => {
    const crash = one([
      debug(0, "*** *** *** *** *** *** *** *** *** *** *** *** *** *** *** ***"),
      debug(0, "pid: 7, tid: 7, name: x  >>> /system/bin/surfaceflinger <<<"),
      debug(0, "signal 11 (SIGSEGV), code 1 (SEGV_MAPERR), fault addr 0x0"),
      debug(0, "      #00 pc 00000000000bd428  /system/lib64/libgui.so (foo+8)"),
    ]);
    expect(crash).toMatchObject({ process: "/system/bin/surfaceflinger", appFrame: null });
    expect(crashBelongsTo(crash, "com.example.notes")).toBe(false);
  });
});
