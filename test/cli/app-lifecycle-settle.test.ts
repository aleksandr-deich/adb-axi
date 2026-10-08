import { afterEach, describe, expect, it, vi } from "vitest";
import type { FakeAdb } from "../fake-adb/harness.js";
import type { Response } from "../fake-adb/scenario.js";

import {
  lifecycleDevices,
  COMMAND_TIMEOUT_MS,
  SHORT_TIMEOUT_MS,
  SHORT_START_DELAY_MS,
  TIMING_MARGIN_MS,
  CURRENT_USER,
  PROCESSES,
  PACKAGE,
  FOREGROUND,
  PIDOF,
  FORCE_STOP,
  START,
  metadataOf,
  METADATA,
  activityInfo,
  INSTALLED,
  PROBE_STOPPED,
  AM_START,
  shell,
  both,
  expectClean,
} from "../helpers/app-lifecycle.js";

// Parity cases run two CLI deadlines sequentially, plus process startup and cleanup.
vi.setConfig({ testTimeout: 40_000 });

let fake: FakeAdb | undefined;
afterEach(() => {
  fake?.cleanup();
  fake = undefined;
});

const { device, deviceWithRules } = lifecycleDevices((value) => {
  fake = value;
});

describe("app start settle deadlines", () => {
  const ui: Response = {
    stdout: "  *APP* UID 10213 ProcessRecord{abc 8123:dev.probe:ui/u0a213}\n",
  };

  const permission: Response = {
    stdout:
      "  ResumedActivity: ActivityRecord{abc u0 com.android.permissioncontroller/.Grant t8}\n",
  };

  it.each(
    [0, 10].flatMap((userId) =>
      [false, true].flatMap((fresh) =>
        ["dev.probe", "dev.probe:ui"].map((process) => ({ userId, fresh, process })),
      ),
    ),
  )(
    "returns the complete short-budget observation, user=$userId, fresh=$fresh, process=$process",
    async ({ userId, fresh, process }) => {
      const other = userId === 0 ? 10 : 0;
      const f = device({
        [CURRENT_USER]: { stdout: `${userId}\n` },
        [PACKAGE]: {
          stdout:
            "Packages:\n  Package [dev.probe] (abc):\n    appId=10213\n    User 0: installed=true hidden=false\n    User 10: installed=true hidden=false\n",
        },
        [START.replace("--user 0", `--user ${userId}`)]: {
          ...AM_START.cold,
          delayMs: SHORT_START_DELAY_MS,
        },
        [FORCE_STOP.replace("--user 0", `--user ${userId}`)]: {},
        [PIDOF]: PROBE_STOPPED,
        [metadataOf(".MainActivity", userId)]: activityInfo(".MainActivity", process),
        [PROCESSES]: {
          stdout: `  *APP* UID ${userId * 100000 + 10213} ProcessRecord{abc 8123:${process}/u${userId}a213}\n  *APP* UID ${userId * 100000 + 10213} ProcessRecord{def 8111:dev.probe:sync/u${userId}a213}\n  *APP* UID ${other * 100000 + 10213} ProcessRecord{fed 9001:${process}/u${other}a213}\n`,
        },
        [FOREGROUND]: {
          stdout: `  ResumedActivity: ActivityRecord{abc u${userId} com.android.permissioncontroller/.Grant t8}\n`,
        },
      });
      const { toon, json, data } = await both(
        [
          "app",
          "start",
          "dev.probe/.MainActivity",
          ...(fresh ? ["--fresh"] : []),
          "--timeout",
          `${SHORT_TIMEOUT_MS}ms`,
        ],
        f,
      );
      expect(toon.exitCode).toBe(0);
      expect(data).toEqual({
        ok: "start dev.probe -> running, com.android.permissioncontroller in front",
        app: {
          activity: ".MainActivity",
          pid: 8123,
          launch: "cold",
          recreated: true,
          took_ms: 1102,
        },
        help: ["Run `adb-axi app current` to see what is in front"],
      });
      expect(toon.durationMs).toBeGreaterThanOrEqual(SHORT_TIMEOUT_MS);
      expect(json.durationMs).toBeGreaterThanOrEqual(SHORT_TIMEOUT_MS);
      expect(toon.durationMs).toBeLessThan(SHORT_TIMEOUT_MS + TIMING_MARGIN_MS);
      expect(json.durationMs).toBeLessThan(SHORT_TIMEOUT_MS + TIMING_MARGIN_MS);
      expect(
        f.calls().filter((call) => call.argv[3] === FOREGROUND && call.exit === 0).length,
      ).toBeGreaterThanOrEqual(2);
      expectClean(f);
    },
  );

  it.each(["process", "foreground"])(
    "keeps the complete observation when a later %s read times out",
    async (step) => {
      const f = deviceWithRules([
        { match: shell(PACKAGE), respond: INSTALLED },
        { match: shell(METADATA), respond: activityInfo(".MainActivity", "dev.probe:ui") },
        { match: shell(START), respond: AM_START.cold, set: { observation: "first" } },
        {
          match: shell(PROCESSES),
          when: { observation: "first" },
          respond: ui,
          set: { observation: "first-front" },
        },
        {
          match: shell(FOREGROUND),
          when: { observation: "first-front" },
          respond: permission,
          set: { observation: "later" },
        },
        {
          match: shell(PROCESSES),
          when: { observation: "later" },
          respond: step === "process" ? { hang: true } : {},
          set: { observation: "later-front" },
        },
        {
          match: shell(FOREGROUND),
          when: { observation: "later-front" },
          respond: { hang: true },
        },
      ]);
      const { toon, data } = await both(
        ["app", "start", "dev.probe/.MainActivity", "--timeout", `${COMMAND_TIMEOUT_MS}ms`],
        f,
      );
      expect(toon.exitCode).toBe(0);
      expect(data).toMatchObject({
        ok: "start dev.probe -> running, com.android.permissioncontroller in front",
        app: { activity: ".MainActivity", pid: 8123 },
      });
      expectClean(f);
    },
  );

  it.each(["process", "foreground"])(
    "bounds a stalled later %s read to the settle window rather than the command timeout",
    async (step) => {
      const f = deviceWithRules([
        { match: shell(PACKAGE), respond: INSTALLED },
        { match: shell(METADATA), respond: activityInfo(".MainActivity", "dev.probe:ui") },
        { match: shell(START), respond: AM_START.cold, set: { observation: "first" } },
        {
          match: shell(PROCESSES),
          when: { observation: "first" },
          respond: ui,
          set: { observation: "first-front" },
        },
        {
          match: shell(FOREGROUND),
          when: { observation: "first-front" },
          respond: permission,
          set: { observation: "later" },
        },
        {
          match: shell(PROCESSES),
          when: { observation: "later" },
          respond: step === "process" ? { hang: true } : {},
          set: { observation: "later-front" },
        },
        {
          match: shell(FOREGROUND),
          when: { observation: "later-front" },
          respond: { hang: true },
        },
      ]);
      const { toon, json, data } = await both(
        ["app", "start", "dev.probe/.MainActivity", "--timeout", `${COMMAND_TIMEOUT_MS}ms`],
        f,
      );
      expect(toon.exitCode).toBe(0);
      expect(toon.durationMs).toBeLessThan(COMMAND_TIMEOUT_MS - TIMING_MARGIN_MS);
      expect(json.durationMs).toBeLessThan(COMMAND_TIMEOUT_MS - TIMING_MARGIN_MS);
      expect(data).toMatchObject({
        ok: "start dev.probe -> running, com.android.permissioncontroller in front",
        app: { activity: ".MainActivity", pid: 8123 },
      });
      const stalledCommand = step === "process" ? PROCESSES : FOREGROUND;
      expect(
        f.calls().filter((call) => call.argv[3] === stalledCommand && call.end === null),
      ).toHaveLength(2);
      expectClean(f);
    },
  );

  it("does not hide a later non-timeout read failure behind an earlier observation", async () => {
    const f = deviceWithRules([
      { match: shell(PACKAGE), respond: INSTALLED },
      { match: shell(METADATA), respond: activityInfo(".MainActivity", "dev.probe:ui") },
      { match: shell(START), respond: AM_START.cold, set: { observation: "first" } },
      {
        match: shell(PROCESSES),
        when: { observation: "first" },
        respond: ui,
        set: { observation: "first-front" },
      },
      {
        match: shell(FOREGROUND),
        when: { observation: "first-front" },
        respond: permission,
        set: { observation: "later" },
      },
      {
        match: shell(PROCESSES),
        when: { observation: "later" },
        respond: { exit: 2, stderr: "Permission denied\n" },
      },
    ]);
    const { toon, data } = await both(
      ["app", "start", "dev.probe/.MainActivity", "--timeout", `${COMMAND_TIMEOUT_MS}ms`],
      f,
    );
    expect(toon.exitCode).toBe(1);
    expect(data).toMatchObject({ code: "REMOTE_EXIT", step: "reading the processes of dev.probe" });
    expect(data).not.toHaveProperty("app");
    expectClean(f);
  });

  it("recognizes process death in a later complete observation despite an earlier live state", async () => {
    const f = deviceWithRules([
      { match: shell(PACKAGE), respond: INSTALLED },
      { match: shell(METADATA), respond: activityInfo(".MainActivity", "dev.probe:ui") },
      { match: shell(START), respond: AM_START.cold, set: { observation: "first" } },
      {
        match: shell(PROCESSES),
        when: { observation: "first" },
        respond: ui,
        set: { observation: "later" },
      },
      {
        match: shell(PROCESSES),
        when: { observation: "later" },
        respond: { stdout: "  *APP* UID 10213 ProcessRecord{def 8111:dev.probe:sync/u0a213}\n" },
      },
      { match: shell(FOREGROUND), respond: permission },
    ]);
    const { toon, data } = await both(
      ["app", "start", "dev.probe/.MainActivity", "--timeout", `${COMMAND_TIMEOUT_MS}ms`],
      f,
    );
    expect(toon.exitCode).toBe(1);
    expect(data).toMatchObject({ code: "APP_DIED_ON_START", last: { state: "stopped", pid: "-" } });
    expect(data).not.toHaveProperty("app");
    expectClean(f);
  });

  it("returns the latest complete observation rather than the first one", async () => {
    const f = deviceWithRules([
      { match: shell(PACKAGE), respond: INSTALLED },
      { match: shell(METADATA), respond: activityInfo(".MainActivity", "dev.probe:ui") },
      { match: shell(START), respond: AM_START.cold, set: { observation: "first" } },
      {
        match: shell(PROCESSES),
        when: { observation: "first" },
        respond: ui,
        set: { observation: "later" },
      },
      {
        match: shell(PROCESSES),
        when: { observation: "later" },
        respond: { stdout: "  *APP* UID 10213 ProcessRecord{def 9123:dev.probe:ui/u0a213}\n" },
      },
      { match: shell(FOREGROUND), respond: permission },
    ]);
    const { toon, data } = await both(
      ["app", "start", "dev.probe/.MainActivity", "--timeout", `${COMMAND_TIMEOUT_MS}ms`],
      f,
    );
    expect(toon.exitCode).toBe(0);
    expect(data).toMatchObject({
      ok: "start dev.probe -> running, com.android.permissioncontroller in front",
      app: { pid: 9123 },
    });
    expectClean(f);
  }, 20000);
});
