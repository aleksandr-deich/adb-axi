import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatDeviceTime, logcatTime, parseDeviceClock } from "../../src/android/clock.js";
import {
  isPackageName,
  parseActivityRecords,
  parseComponent,
} from "../../src/android/component.js";
import { parseForeground } from "../../src/android/foreground.js";
import { atLeast, parseLogcat, parseLogLine } from "../../src/android/logcat.js";
import {
  parseDumpsysPackage,
  parsePackageList,
  parsePackageRecords,
} from "../../src/android/packages.js";
import { parsePidof } from "../../src/android/pidof.js";
import {
  amKillCanKill,
  importanceForAdj,
  parseLru,
  parseProcesses,
} from "../../src/android/processes.js";
import { findTask, parseRecents } from "../../src/android/recents.js";
import { FIXTURES_DIR } from "../fake-adb/harness.js";

/** Real output recorded by E0 on the API 35 tablet and the API 37 phone. */
function captured(api: "35" | "37", file: string): string {
  return readFileSync(join(FIXTURES_DIR, "captured", api, file), "utf8");
}

/** API 29/30 output written from AOSP sources (`synthetic/<api>/index.json`). */
function synthetic(api: "29" | "30", file: string): string {
  return readFileSync(join(FIXTURES_DIR, "synthetic", api, file), "utf8");
}

/** The probe's facts per captured API level. */
const PROBE = {
  "35": { pid: 8235, uid: 10213, task: 9, launcher: 7 },
  "37": { pid: 7882, uid: 10264, task: 1057, launcher: 2 },
} as const;
const APIS = ["35", "37"] as const;
const LAUNCHER = "com.google.android.apps.nexuslauncher";

describe("component", () => {
  it("splits a flattened component and keeps the short activity form", () => {
    expect(parseComponent("dev.probe/.MainActivity")).toEqual({
      package: "dev.probe",
      activity: ".MainActivity",
      component: "dev.probe/.MainActivity",
    });
    expect(parseComponent("com.android.settings/com.android.settings.FallbackHome")?.activity).toBe(
      "com.android.settings.FallbackHome",
    );
    expect(parseComponent("not a component")).toBeNull();
  });

  it("reads activity records, finishing ones included", () => {
    expect(
      parseActivityRecords(
        "Activities=[ActivityRecord{6e0f4b9 u0 a.b/.One t9}, ActivityRecord{f17a2c5 u10 a.b/.Two t9 f}]",
      ),
    ).toEqual([
      { package: "a.b", activity: ".One", component: "a.b/.One", taskId: 9 },
      { package: "a.b", activity: ".Two", component: "a.b/.Two", taskId: 9 },
    ]);
  });

  it("filters activity records by Android user without changing unscoped reads", () => {
    const text =
      "Activities=[ActivityRecord{abc u0 dev.probe/.Personal t2}, ActivityRecord{def u10 dev.probe/.Work t8}]";
    expect(parseActivityRecords(text)).toHaveLength(2);
    expect(parseActivityRecords(text, 0)).toEqual([
      { package: "dev.probe", activity: ".Personal", component: "dev.probe/.Personal", taskId: 2 },
    ]);
    expect(parseActivityRecords(text, 10)).toEqual([
      { package: "dev.probe", activity: ".Work", component: "dev.probe/.Work", taskId: 8 },
    ]);
    expect(parseActivityRecords(text, 11)).toEqual([]);
  });

  it("accepts package names and rejects anything a shell would read as syntax", () => {
    expect(isPackageName("dev.probe")).toBe(true);
    expect(isPackageName("android")).toBe(true);
    expect(isPackageName("com.example_app.v2")).toBe(true);
    for (const bad of [
      "",
      "dev.probe; reboot",
      "dev..probe",
      "1dev.probe",
      "dev.probe ",
      "$(id)",
    ]) {
      expect(isPackageName(bad), bad).toBe(false);
    }
  });
});

describe("parsePidof", () => {
  it.each(APIS)("reads the running pid and the empty answer on API %s", (api) => {
    expect(parsePidof(captured(api, "pidof-running.txt"))).toEqual([PROBE[api].pid]);
    expect(parsePidof(captured(api, "pidof-not-running.txt"))).toEqual([]);
    // S5: `am kill` on the app in front left the same pid.
    expect(parsePidof(captured(api, "pidof-after-kill-foreground.txt"))).toEqual([PROBE[api].pid]);
    expect(parsePidof(captured(api, "pidof-after-kill-previous.txt"))).toEqual([]);
    expect(parsePidof(captured(api, "pidof-after-clear.txt"))).toEqual([]);
  });

  it("reads one, several and no pids on API 29 and 30 (synthetic)", () => {
    expect(parsePidof(synthetic("29", "pidof-running.txt"))).toEqual([5120]);
    expect(parsePidof(synthetic("29", "pidof-two.txt"))).toEqual([5120, 5187]);
    expect(parsePidof(synthetic("29", "pidof-not-running.txt"))).toEqual([]);
    expect(parsePidof(synthetic("30", "pidof-not-running.txt"))).toEqual([]);
  });

  it("refuses output that is not a pid list", () => {
    expect(parsePidof("pidof: not found\n")).toBeNull();
    expect(parsePidof("0\n")).toBeNull();
  });
});

describe("parsePackageList", () => {
  it.each(APIS)("reads every package line on API %s", (api) => {
    const text = captured(api, "pm-list-packages.txt");
    const packages = parsePackageList(text);
    expect(packages).toHaveLength(text.split("\n").filter((l) => l.startsWith("package:")).length);
    expect(packages.map((p) => p.package)).toContain("dev.probe");
    expect(
      parsePackageList(captured(api, "pm-list-packages-3.txt")).map((p) => p.package),
    ).toContain("dev.probe");
    expect(parsePackageList(captured(api, "pm-list-packages-absent.txt"))).toEqual([]);
  });

  it.each(APIS)("reads the uid and versionCode tokens on API %s", (api) => {
    expect(parsePackageList(captured(api, "pm-list-packages-uid.txt"))).toEqual([
      { package: "dev.probe", versionCode: null, uid: PROBE[api].uid },
    ]);
    expect(parsePackageList(captured(api, "pm-list-packages-versioncode.txt"))).toEqual([
      { package: "dev.probe", versionCode: 1, uid: null },
    ]);
  });

  it("reads both tokens on one line (API 29, synthetic) and the -f form", () => {
    expect(parsePackageList(synthetic("29", "pm-list-packages-versioncode-uid.txt"))).toEqual([
      { package: "com.example.notes", versionCode: 57, uid: 10124 },
      { package: "dev.probe", versionCode: 1, uid: 10123 },
    ]);
    expect(parsePackageList("package:/data/app/x==/base.apk=dev.probe\n")).toEqual([
      { package: "dev.probe", versionCode: null, uid: null },
    ]);
  });
});

describe("parseDumpsysPackage", () => {
  it.each(APIS)("reads the debuggable and the release build on API %s", (api) => {
    expect(parseDumpsysPackage(captured(api, "dumpsys-package-debug.txt"), "dev.probe")).toEqual({
      package: "dev.probe",
      installed: true,
      versionName: "1.0",
      versionCode: 1,
      debuggable: true,
      system: false,
      uid: PROBE[api].uid,
      minSdk: 29,
      targetSdk: 36,
    });
    expect(
      parseDumpsysPackage(captured(api, "dumpsys-package-release.txt"), "dev.probe"),
    ).toMatchObject({ installed: true, versionCode: 1, debuggable: false, uid: PROBE[api].uid });
  });

  it.each(APIS)("answers null for a package that is not installed on API %s", (api) => {
    expect(
      parseDumpsysPackage(captured(api, "dumpsys-package-absent.txt"), "dev.probe.missing"),
    ).toBeNull();
    // A name that is not the record's is not the record.
    expect(parseDumpsysPackage(captured(api, "dumpsys-package-debug.txt"), "dev.prob")).toBeNull();
  });

  it("reads the userId= form of API 29 and 30 (synthetic)", () => {
    expect(parseDumpsysPackage(synthetic("29", "dumpsys-package-debug.txt"), "dev.probe")).toEqual({
      package: "dev.probe",
      installed: true,
      versionName: "1.0",
      versionCode: 1,
      debuggable: true,
      system: false,
      uid: 10123,
      minSdk: 29,
      targetSdk: 29,
    });
    expect(
      parseDumpsysPackage(synthetic("29", "dumpsys-package-absent.txt"), "dev.probe.missing"),
    ).toBeNull();
    expect(
      parseDumpsysPackage(synthetic("30", "dumpsys-package-release.txt"), "dev.probe"),
    ).toMatchObject({ installed: true, debuggable: false, uid: 10123, targetSdk: 30 });
  });

  it("reports a package uninstalled with its data kept as not installed (API 30, synthetic)", () => {
    expect(
      parseDumpsysPackage(synthetic("30", "dumpsys-package-kept-data.txt"), "dev.probe"),
    ).toEqual({
      package: "dev.probe",
      installed: false,
      versionName: null,
      versionCode: 1,
      debuggable: false,
      system: false,
      uid: 10123,
      minSdk: null,
      targetSdk: null,
    });
  });

  it.each(["appId", "userId"])(
    "reads installation and uid for the selected user from %s records",
    (id) => {
      const text = `Packages:\n  Package [dev.probe] (abc):\n    ${id}=10213\n    User 0: installed=false hidden=false\n    User 10: installed=true hidden=false\n`;
      expect(parseDumpsysPackage(text, "dev.probe", 0)).toMatchObject({
        installed: false,
        uid: 10213,
      });
      expect(parseDumpsysPackage(text, "dev.probe", 10)).toMatchObject({
        installed: true,
        uid: 1010213,
      });
      expect(parseDumpsysPackage(text, "dev.probe", 11)).toMatchObject({
        installed: false,
        uid: 1110213,
      });
      expect(parseDumpsysPackage(text, "dev.probe")).toEqual(
        parseDumpsysPackage(text, "dev.probe", 0),
      );
    },
  );

  it("ignores hidden system packages, which are not the installed copy", () => {
    const records = parsePackageRecords(synthetic("30", "dumpsys-package-release.txt"));
    expect([...records.keys()]).toEqual(["dev.probe"]);
  });
});

describe("parseForeground", () => {
  it.each(APIS)("names the resumed app, launcher included, on API %s", (api) => {
    expect(parseForeground(captured(api, "dumpsys-activity-activities-probe-front.txt"))).toEqual({
      package: "dev.probe",
      activity: ".MainActivity",
      component: "dev.probe/.MainActivity",
      taskId: PROBE[api].task,
    });
    for (const file of [
      "dumpsys-activity-activities-launcher-front.txt",
      "dumpsys-activity-activities-after-kill.txt",
    ]) {
      expect(parseForeground(captured(api, file)), file).toEqual({
        package: LAUNCHER,
        activity: ".NexusLauncherActivity",
        component: `${LAUNCHER}/.NexusLauncherActivity`,
        taskId: PROBE[api].launcher,
      });
    }
  });

  it.each(["ResumedActivity: ", "Resumed: ", "mResumedActivity: ", "topResumedActivity="])(
    "scopes %s foreground records to the selected user",
    (prefix) => {
      const text = `  ${prefix}ActivityRecord{abc u0 dev.probe/.Personal t2}\n  ${prefix}ActivityRecord{def u10 dev.probe/.Work t8}\n`;
      expect(parseForeground(text)?.activity).toBe(".Personal");
      expect(parseForeground(text, 0)?.activity).toBe(".Personal");
      expect(parseForeground(text, 10)?.activity).toBe(".Work");
      expect(parseForeground(text, 11)).toBeNull();
    },
  );

  it("reads the API 29 and 30 layouts (synthetic)", () => {
    expect(
      parseForeground(synthetic("29", "dumpsys-activity-activities-probe-front.txt")),
    ).toMatchObject({ component: "dev.probe/.MainActivity", taskId: 12 });
    expect(
      parseForeground(synthetic("30", "dumpsys-activity-activities-launcher-front.txt")),
    ).toMatchObject({ package: LAUNCHER, taskId: 3 });
  });

  it("falls back to the per-stack and per-task lines", () => {
    const api29 = synthetic("29", "dumpsys-activity-activities-probe-front.txt")
      .split("\n")
      .filter((line) => !/^\s*ResumedActivity:/.test(line))
      .join("\n");
    expect(parseForeground(api29)?.component).toBe("dev.probe/.MainActivity");
    const api37 = captured("37", "dumpsys-activity-activities-probe-front.txt")
      .split("\n")
      .filter((line) => !/^\s*ResumedActivity:/.test(line))
      .join("\n");
    expect(parseForeground(api37)?.component).toBe("dev.probe/.MainActivity");
  });

  it("answers null when nothing is resumed (API 30 asleep, synthetic)", () => {
    expect(parseForeground(synthetic("30", "dumpsys-activity-activities-asleep.txt"))).toBeNull();
    expect(parseForeground("")).toBeNull();
  });
});

describe("parseProcesses", () => {
  it.each(APIS)("reads the probe in front and as the previous app on API %s", (api) => {
    const process = { pid: PROBE[api].pid, process: "dev.probe", uid: PROBE[api].uid };
    expect(parseProcesses(captured(api, "dumpsys-activity-processes-probe-front.txt"))).toEqual([
      { ...process, adj: 0, importance: "foreground", procState: 2, cached: false },
    ]);
    expect(parseProcesses(captured(api, "dumpsys-activity-processes-probe-previous.txt"))).toEqual([
      { ...process, adj: 700, importance: "previous", procState: 15, cached: false },
    ]);
  });

  it("reads how a backgrounded app looks after a minute, per API level (E0)", () => {
    // API 37 caches the previous app; API 35 keeps it the previous app (EVIDENCE.md).
    expect(parseProcesses(captured("37", "dumpsys-activity-processes-probe-cached.txt"))).toEqual([
      {
        pid: 7882,
        process: "dev.probe",
        uid: 10264,
        adj: 900,
        importance: "cached",
        procState: 15,
        cached: true,
      },
    ]);
    expect(
      parseProcesses(captured("35", "dumpsys-activity-processes-probe-previous-after-watch.txt")),
    ).toMatchObject([{ adj: 700, importance: "previous", cached: false }]);
  });

  it("reads the oom: and oom adj: forms of API 29 and 30 (synthetic)", () => {
    expect(
      parseProcesses(synthetic("29", "dumpsys-activity-processes-probe-previous.txt")),
    ).toEqual([
      {
        pid: 5120,
        process: "dev.probe",
        uid: 10123,
        adj: 700,
        importance: "previous",
        procState: 15,
        cached: false,
      },
    ]);
    expect(
      parseProcesses(synthetic("30", "dumpsys-activity-processes-probe-cached.txt")),
    ).toMatchObject([
      { pid: 6011, process: "dev.probe", adj: 900, importance: "cached", cached: true },
      { pid: 6044, process: "dev.probe:sync", adj: 905, importance: "cached", procState: 19 },
    ]);
  });

  it("knows am kill spares the app in front and kills it once backgrounded (S5, E0)", () => {
    const adjOf = (api: "35" | "37", file: string): number =>
      parseProcesses(captured(api, file))[0]?.adj ?? Number.NaN;
    for (const api of APIS) {
      expect(amKillCanKill(adjOf(api, "dumpsys-activity-processes-probe-front.txt"))).toBe(false);
      expect(amKillCanKill(adjOf(api, "dumpsys-activity-processes-probe-previous.txt"))).toBe(true);
    }
    expect(amKillCanKill(adjOf("37", "dumpsys-activity-processes-probe-cached.txt"))).toBe(true);
    // The perceptible step right after HOME is still too important.
    expect(amKillCanKill(200)).toBe(false);
    expect(amKillCanKill(500)).toBe(true);
  });

  it("names the importance band of every oom adj", () => {
    expect(
      [-900, 0, 50, 100, 200, 250, 300, 400, 500, 600, 700, 799, 800, 900, 999].map(
        importanceForAdj,
      ),
    ).toEqual([
      "persistent",
      "foreground",
      "foreground",
      "visible",
      "perceptible",
      "perceptible",
      "backup",
      "heavy",
      "service",
      "home",
      "previous",
      "previous",
      "service-b",
      "cached",
      "cached",
    ]);
  });
});

describe("parseLru", () => {
  const lruFiles = {
    "35": [
      "dumpsys-activity-lru-probe-front.txt",
      "dumpsys-activity-lru-previous.txt",
      "dumpsys-activity-lru-previous-after-watch.txt",
      "dumpsys-activity-lru-no-activity.txt",
    ],
    "37": [
      "dumpsys-activity-lru-probe-front.txt",
      "dumpsys-activity-lru-previous.txt",
      "dumpsys-activity-lru-cached.txt",
      "dumpsys-activity-lru-no-activity.txt",
    ],
  } as const;

  it.each(APIS)("reads every entry with a known oom adj on API %s", (api) => {
    for (const file of lruFiles[api]) {
      const text = captured(api, file);
      const entries = parseLru(text);
      expect(entries, file).toHaveLength(
        text.split("\n").filter((l) => /^\s*#\s*\d+:/.test(l)).length,
      );
      expect(
        entries.filter((e) => e.adj === null),
        file,
      ).toEqual([]);
    }
  });

  it.each(APIS)("follows the probe from front to previous on API %s", (api) => {
    const probe = (file: string) =>
      parseLru(captured(api, file)).find((e) => e.process === "dev.probe");
    expect(probe("dumpsys-activity-lru-probe-front.txt")).toMatchObject({
      pid: PROBE[api].pid,
      adjLabel: "fg",
      adj: 0,
      importance: "foreground",
      procState: "TOP",
      activities: true,
    });
    expect(probe("dumpsys-activity-lru-previous.txt")).toMatchObject({
      adjLabel: "prev",
      importance: "previous",
      procState: "LAST",
    });
  });

  it("reads cached, padded and offset labels (API 37 and 35)", () => {
    const api37 = parseLru(captured("37", "dumpsys-activity-lru-cached.txt"));
    expect(api37.find((e) => e.process === "dev.probe")).toMatchObject({
      adjLabel: "cch",
      adj: 900,
      importance: "cached",
    });
    expect(api37.find((e) => e.pid === 22811)).toMatchObject({
      process: "com.google.android.gms",
      adjLabel: "cch+45",
      adj: 945,
      activities: false,
    });
    const api35 = parseLru(captured("35", "dumpsys-activity-lru-previous.txt"));
    expect(api35.find((e) => e.pid === 6875)).toMatchObject({ adjLabel: "cch+5", adj: 905 });
    expect(api35.find((e) => e.pid === 552)).toMatchObject({
      process: "system",
      user: "1000",
      importance: "persistent",
    });
  });

  it("reads the API 29 and 30 layouts (synthetic)", () => {
    const api29 = parseLru(synthetic("29", "dumpsys-activity-lru-previous.txt"));
    expect(api29).toHaveLength(9);
    expect(api29[0]).toMatchObject({
      adjLabel: "fore",
      importance: "foreground",
      activities: true,
    });
    expect(api29.find((e) => e.process === "dev.probe")).toMatchObject({
      pid: 5120,
      importance: "previous",
      activities: true,
    });
    expect(api29.find((e) => e.pid === 1288)?.activities).toBe(false);
    const api30 = parseLru(synthetic("30", "dumpsys-activity-lru-cached.txt"));
    expect(api30).toHaveLength(9);
    expect(api30.find((e) => e.process === "dev.probe")).toMatchObject({
      adj: 900,
      procState: "CAC",
    });
    expect(api30.at(-1)).toMatchObject({ pid: 517, importance: "persistent" });
  });
});

describe("parseRecents", () => {
  it.each(APIS)("keeps the probe task after the kill on API %s", (api) => {
    const tasks = parseRecents(captured(api, "dumpsys-activity-recents-after-kill.txt"));
    expect(findTask(tasks, "dev.probe", 0)).toEqual({
      index: 1,
      taskId: PROBE[api].task,
      userId: 0,
      type: "standard",
      package: "dev.probe",
      activity: ".MainActivity",
      component: "dev.probe/.MainActivity",
      activities: ["dev.probe/.MainActivity"],
      rootPid: null,
    });
    expect(tasks[0]).toMatchObject({ type: "home", package: LAUNCHER });
  });

  it.each(APIS)("names the root process while the app runs on API %s", (api) => {
    const tasks = parseRecents(captured(api, "dumpsys-activity-recents-probe-front.txt"));
    expect(tasks[0]).toMatchObject({ package: "dev.probe", rootPid: PROBE[api].pid });
  });

  it("leaves out the visible-tasks section and hidden tasks", () => {
    const api37 = parseRecents(captured("37", "dumpsys-activity-recents-probe-front.txt"));
    // mHiddenTasks lists older dev.probe tasks; none of them is a recent task.
    expect(api37.filter((t) => t.package === "dev.probe").map((t) => t.taskId)).toEqual([1057]);
    expect(api37.map((t) => t.index)).toEqual(api37.map((_, i) => i));
    const api35 = parseRecents(captured("35", "dumpsys-activity-recents-after-kill.txt"));
    expect(api35).toHaveLength(3);
  });

  it("reads TaskRecord headers and the activity type number (API 29, synthetic)", () => {
    const tasks = parseRecents(synthetic("29", "dumpsys-activity-recents-after-kill.txt"));
    expect(tasks.map((t) => [t.taskId, t.type, t.package])).toEqual([
      [2, "home", LAUNCHER],
      [12, "standard", "dev.probe"],
      [9, "standard", "com.example.notes"],
    ]);
    expect(findTask(tasks, "dev.probe", 0)).toMatchObject({
      activity: ".MainActivity",
      rootPid: null,
    });
    expect(findTask(tasks, "com.example.notes", 0)).toMatchObject({
      activity: ".ui.NotesActivity",
      activities: ["com.example.notes/.ui.NotesActivity", "com.example.notes/.ui.EditorActivity"],
      rootPid: 4470,
    });
  });

  it("reads Task headers (API 30, synthetic)", () => {
    const tasks = parseRecents(synthetic("30", "dumpsys-activity-recents-after-kill.txt"));
    expect(findTask(tasks, "dev.probe", 0)).toMatchObject({
      index: 1,
      taskId: 14,
      type: "standard",
      component: "dev.probe/.MainActivity",
    });
  });

  it("finds no task for a package without one, and never a home task", () => {
    const tasks = parseRecents(captured("37", "dumpsys-activity-recents-after-kill.txt"));
    expect(findTask(tasks, "dev.probe.missing", 0)).toBeUndefined();
    expect(findTask(tasks, LAUNCHER, 0)).toBeUndefined();
  });
});

describe("parseLogcat", () => {
  const files = [
    "logcat-epoch.txt",
    "logcat-epoch-uid.txt",
    "logcat-epoch-since.txt",
    "logcat-crash-java.txt",
    "logcat-crash-native.txt",
    "logcat-all-java-crash.txt",
    "logcat-all-native-crash.txt",
    "logcat-anr-main.txt",
    "logcat-anr-system.txt",
    "logcat-anr-events.txt",
    "logcat-anr-crash.txt",
    "logcat-probestate.txt",
  ];

  it.each(APIS)("reads every line of every -v epoch capture on API %s", (api) => {
    for (const file of files) {
      const text = captured(api, file);
      const { lines, unparsed } = parseLogcat(text);
      const expected = text
        .split("\n")
        .filter((l) => l.trim() !== "" && !l.startsWith("---------"));
      expect(unparsed, file).toBe(0);
      expect(lines, file).toHaveLength(expected.length);
    }
  });

  it("reads a Java crash block from the crash buffer (API 37)", () => {
    const { lines } = parseLogcat(captured("37", "logcat-crash-java.txt"));
    expect(lines[0]).toEqual({
      epochMs: 1790834185610,
      time: "1790834185.610",
      pid: 8931,
      tid: 8931,
      level: "E",
      tag: "AndroidRuntime",
      message: "FATAL EXCEPTION: main",
      buffer: "crash",
    });
    expect(lines[1]?.message).toBe("Process: dev.probe, PID: 8931");
    expect(lines[3]?.message).toBe("\tat dev.probe.MainActivity.dispatch(MainActivity.kt:67)");
  });

  it.each(APIS)("finds the ANR report in the system buffer only on API %s (E0)", (api) => {
    const anr = (file: string) =>
      parseLogcat(captured(api, file)).lines.filter((l) =>
        l.message.startsWith("ANR in dev.probe"),
      );
    expect(anr("logcat-anr-system.txt")).toMatchObject([
      { level: "E", tag: "ActivityManager", buffer: "system" },
    ]);
    expect(anr("logcat-anr-main.txt")).toEqual([]);
    expect(anr("logcat-anr-crash.txt")).toEqual([]);
  });

  it.each(APIS)("tracks the buffer of each line in an all-buffer dump on API %s", (api) => {
    const { lines } = parseLogcat(captured(api, "logcat-all-native-crash.txt"));
    const fatal = lines.find((l) => l.message.startsWith("Fatal signal 11"));
    expect(fatal).toMatchObject({ level: "F", tag: "libc", buffer: "crash" });
    expect(new Set(lines.map((l) => l.buffer))).toEqual(
      new Set(["main", "system", "events", "crash", ...(api === "37" ? ["radio"] : [])]),
    );
  });

  it("reads markers, buffer switches and empty messages (API 29, synthetic)", () => {
    const { lines, unparsed } = parseLogcat(synthetic("29", "logcat-epoch.txt"));
    expect(unparsed).toBe(0);
    expect(lines.map((l) => [l.buffer, l.level, l.tag])).toEqual([
      ["main", "I", "dev.probe"],
      ["main", "W", "dev.probe"],
      ["main", "D", "OpenGLRenderer"],
      ["main", "I", "ProbeState"],
      ["system", "I", "ActivityManager"],
      ["system", "V", "WindowManager"],
      ["main", "E", "ProbeState"],
    ]);
    expect(lines[5]?.message).toBe("");
    expect(lines[6]?.message).toBe("");
  });

  it("reads a tag padded to eight columns (API 30, synthetic)", () => {
    const { lines } = parseLogcat(synthetic("30", "logcat-epoch-crash.txt"));
    expect(lines.at(-1)).toMatchObject({
      tag: "Process",
      message: "Sending signal. PID: 6011 SIG: 9",
      buffer: "main",
    });
    expect(lines[0]).toMatchObject({ buffer: "crash", message: "FATAL EXCEPTION: main" });
  });

  it("refuses lines that are not -v epoch lines", () => {
    expect(parseLogLine("10-01 07:56:25.610  8931  8931 E AndroidRuntime: x")).toBeNull();
    expect(parseLogLine("")).toBeNull();
    expect(parseLogcat("garbage\n").unparsed).toBe(1);
  });

  it("orders levels like logcat filters", () => {
    expect(atLeast("E", "W")).toBe(true);
    expect(atLeast("W", "W")).toBe(true);
    expect(atLeast("I", "W")).toBe(false);
    expect(atLeast("F", "V")).toBe(true);
  });
});

describe("device clock", () => {
  it.each(APIS)("reads date +%%s.%%N on API %s to the millisecond", (api) => {
    const text = captured(api, "date-epoch.txt");
    const [seconds = "", fraction = ""] = text.trim().split(".");
    expect(parseDeviceClock(text)).toEqual({
      epochMs: Number(seconds) * 1000 + Number(fraction.slice(0, 3)),
      logcatTime: `${seconds}.${fraction.slice(0, 3)}`,
      utcOffsetMinutes: null,
    });
  });

  it("reads the UTC offset east and west of UTC (API 29 and 30, synthetic)", () => {
    const east = parseDeviceClock(synthetic("29", "date-epoch-zone.txt"));
    expect(east).toEqual({
      epochMs: 1790834220608,
      logcatTime: "1790834220.608",
      utcOffsetMinutes: 120,
    });
    expect(formatDeviceTime(east?.epochMs ?? 0, east?.utcOffsetMinutes ?? null)).toBe(
      "2026-10-01 07:57:00.608",
    );
    const west = parseDeviceClock(synthetic("30", "date-epoch-zone.txt"));
    expect(west?.utcOffsetMinutes).toBe(-420);
    expect(formatDeviceTime(west?.epochMs ?? 0, west?.utcOffsetMinutes ?? null)).toBe(
      "2026-09-30 22:55:10.420",
    );
  });

  it("formats logcat -T times with three decimals", () => {
    expect(logcatTime(1790834220005)).toBe("1790834220.005");
    expect(logcatTime(1790834220000)).toBe("1790834220.000");
    expect(parseDeviceClock("1790834220\n")?.logcatTime).toBe("1790834220.000");
    expect(formatDeviceTime(0, null)).toBe("1970-01-01 00:00:00.000");
  });

  it("refuses output that is not a clock reading", () => {
    expect(parseDeviceClock("date: bad format\n")).toBeNull();
    expect(parseDeviceClock("")).toBeNull();
  });
});
