import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  declaredActivities,
  parseActivityFilters,
  parseActivityProcessName,
} from "../../src/android/activities.js";
import { parseAmStart, wasRecreated } from "../../src/android/amstart.js";
import { FIXTURES_DIR } from "../fake-adb/harness.js";

function fixture(group: "captured/35" | "captured/37" | "synthetic/29", file: string): string {
  return readFileSync(join(FIXTURES_DIR, group, file), "utf8");
}

const LEVELS = ["captured/35", "captured/37", "synthetic/29"] as const;
const PROBE_ACTIVITY = {
  package: "dev.probe",
  activity: ".MainActivity",
  component: "dev.probe/.MainActivity",
};

describe("parseAmStart", () => {
  it.each(LEVELS)("reads a cold start on %s as created anew, with its total time", (group) => {
    const start = parseAmStart(fixture(group, "am-start-cold.txt"));
    expect(start).toMatchObject({
      status: "ok",
      launch: "cold",
      notStarted: null,
      activity: PROBE_ACTIVITY,
      error: null,
    });
    expect(start.totalTimeMs).toBeGreaterThan(0);
    expect(wasRecreated(start)).toBe(true);
  });

  it.each(["captured/35", "captured/37"] as const)("reads a warm start on %s", (group) => {
    const start = parseAmStart(fixture(group, "am-start-warm.txt"));
    expect(start).toMatchObject({ status: "ok", launch: "warm", notStarted: null });
    expect(wasRecreated(start)).toBe(true);
  });

  it.each(LEVELS)(
    "turns the 'Activity not started' warning of a task brought to the front on %s into state (S4)",
    (group) => {
      const start = parseAmStart(fixture(group, "am-start-hot.txt"));
      expect(start).toMatchObject({
        status: "ok",
        launch: "hot",
        notStarted: "brought-to-front",
      });
      expect(wasRecreated(start)).toBe(false);
    },
  );

  it.each(LEVELS)(
    "reads LaunchState: UNKNOWN (0) of an intent delivered to the top on %s as launch unknown, not recreated (12.2)",
    (group) => {
      const start = parseAmStart(fixture(group, "am-start-delivered-to-top.txt"));
      expect(start).toMatchObject({
        status: "ok",
        launch: "unknown",
        notStarted: "delivered-to-top",
        totalTimeMs: 0,
      });
      expect(wasRecreated(start)).toBe(false);
    },
  );

  it.each(["captured/35", "captured/37"] as const)(
    "counts a task brought to the front with a new process on %s as recreated, despite the warning",
    (group) => {
      const start = parseAmStart(fixture(group, "am-start-restore-after-kill.txt"));
      expect(start).toMatchObject({ launch: "cold", notStarted: "brought-to-front" });
      expect(wasRecreated(start)).toBe(true);
    },
  );

  it("reads Status: timeout on API 29, with no total time and launch unknown", () => {
    expect(parseAmStart(fixture("synthetic/29", "am-start-timeout.txt"))).toMatchObject({
      status: "timeout",
      launch: "unknown",
      totalTimeMs: null,
      activity: PROBE_ACTIVITY,
      error: null,
    });
  });

  it.each(LEVELS)("reads Error type 3 on %s as a missing class", (group) => {
    const start = parseAmStart(fixture(group, "am-start-missing-activity.txt"));
    expect(start).toMatchObject({ status: null, launch: "unknown", activity: null });
    expect(start.error).toEqual({
      classNotFound: true,
      detail: "Error type 3 Error: Activity class {dev.probe/dev.probe.Missing} does not exist.",
    });
  });

  it("reads any other error as a refusal that is not a missing class", () => {
    const start = parseAmStart(
      "Starting: Intent { cmp=dev.probe/.Secret }\n" +
        "Error: Activity not started, you do not have permission to access it.\n",
    );
    expect(start.error).toEqual({
      classNotFound: false,
      detail: "Error: Activity not started, you do not have permission to access it.",
    });
  });

  it("reads output without a LaunchState line as launch unknown", () => {
    const start = parseAmStart(
      "Starting: Intent { cmp=dev.probe/.MainActivity }\nStatus: ok\n" +
        "Activity: dev.probe/.MainActivity\nTotalTime: 640\nWaitTime: 650\nComplete\n",
    );
    expect(start).toMatchObject({ status: "ok", launch: "unknown", totalTimeMs: 640 });
    expect(wasRecreated(start)).toBe(true);
  });

  it("reads the other two 'Activity not started' warnings as kept", () => {
    for (const warning of [
      "Warning: Activity not started because the  current activity is being kept for the user.",
      "Warning: Activity not started because intent should be handled by the caller",
    ]) {
      const start = parseAmStart(`${warning}\nStatus: ok\nLaunchState: UNKNOWN (0)\nComplete\n`);
      expect(start.notStarted).toBe("kept");
      expect(wasRecreated(start)).toBe(false);
    }
  });

  it("finds no status in text that is not am start output", () => {
    expect(parseAmStart("")).toMatchObject({ status: null, error: null, activity: null });
  });
});

describe("ActivityInfo process identity", () => {
  it.each([".MainActivity", "dev.probe.MainActivity"])(
    "reads a package process for %s without using nested application fields",
    (activity) => {
      const stdout = [
        "priority=0 preferredOrder=0 match=0x100000 specificIndex=-1 isDefault=false",
        "ActivityInfo:",
        " name=dev.probe.MainActivity",
        " packageName=dev.probe",
        " enabled=true exported=true",
        " ApplicationInfo:",
        "  name=dev.probe.Application",
        "  packageName=dev.probe",
        "  processName=dev.probe:application",
        "",
      ].join("\n");
      expect(
        parseActivityProcessName(stdout, {
          ...PROBE_ACTIVITY,
          activity,
          component: `dev.probe/${activity}`,
        }),
      ).toBe("dev.probe");
    },
  );

  it.each(["dev.probe:ui", "com.example.shared"])(
    "reads the activity's declared process %s rather than the application default",
    (process) => {
      const stdout = `ActivityInfo:\n name=dev.probe.MainActivity\n packageName=dev.probe\n processName=${process}\n ApplicationInfo:\n  processName=dev.probe\n`;
      expect(parseActivityProcessName(stdout, PROBE_ACTIVITY)).toBe(process);
    },
  );

  it("reads the process of a declared alias without replacing its identity with targetActivity", () => {
    const stdout =
      "ActivityInfo:\n name=dev.probe.IconAlias\n packageName=dev.probe\n processName=dev.probe:ui\n taskAffinity=dev.probe targetActivity=dev.probe.MainActivity\n ApplicationInfo:\n  processName=dev.probe\n";
    expect(
      parseActivityProcessName(stdout, {
        ...PROBE_ACTIVITY,
        activity: ".IconAlias",
        component: "dev.probe/.IconAlias",
      }),
    ).toBe("dev.probe:ui");
  });

  it.each([
    "No activity found\n",
    "ActivityInfo: null\n",
    "ActivityInfo:\n name=dev.probe.Other\n packageName=dev.probe\n",
    "ActivityInfo:\n name=dev.probe.MainActivity\n packageName=com.other\n",
    "ActivityInfo:\n ApplicationInfo:\n  name=dev.probe.MainActivity\n  packageName=dev.probe\n",
    "ActivityInfo:\n name=dev.probe.MainActivity\n packageName=dev.probe\n processName=\n",
  ])("refuses ActivityInfo that cannot establish the component process (%s)", (stdout) => {
    expect(parseActivityProcessName(stdout, PROBE_ACTIVITY)).toBeNull();
  });
});

describe("activity resolver table", () => {
  it.each(LEVELS)("lists the probe's declared activity on %s", (group) => {
    const filters = parseActivityFilters(fixture(group, "dumpsys-package-debug.txt"));
    expect(declaredActivities(filters, "dev.probe")).toEqual([".MainActivity"]);
  });

  it("ignores the receiver table, names each activity once and keeps the printed order", () => {
    const dump = [
      "Activity Resolver Table:",
      "  Non-Data Actions:",
      "      android.intent.action.VIEW:",
      "        1a2b3c4 com.example.notes/.EditorActivity filter 5d6e7f8",
      '          Action: "android.intent.action.VIEW"',
      "      android.intent.action.MAIN:",
      "        9a8b7c6 com.example.notes/.MainActivity filter 1f2e3d4",
      '          Action: "android.intent.action.MAIN"',
      '          Category: "android.intent.category.LAUNCHER"',
      "        2b3c4d5 com.example.notes/.EditorActivity filter 6e7f8a9",
      '          Action: "android.intent.action.MAIN"',
      "",
      "Receiver Resolver Table:",
      "  Non-Data Actions:",
      "      android.intent.action.BOOT_COMPLETED:",
      "        3c4d5e6 com.example.notes/.BootReceiver filter 7f8a9b0",
      '          Action: "android.intent.action.BOOT_COMPLETED"',
      "",
    ].join("\n");
    const filters = parseActivityFilters(dump);
    expect(declaredActivities(filters, "com.example.notes")).toEqual([
      ".EditorActivity",
      ".MainActivity",
    ]);
    expect(declaredActivities(filters, "com.example.other")).toEqual([]);
  });

  it("finds no launcher activity in a dump without the table", () => {
    const filters = parseActivityFilters(fixture("captured/35", "dumpsys-package-absent.txt"));
    expect(filters).toEqual([]);
    expect(declaredActivities(filters, "dev.probe")).toEqual([]);
  });
});
