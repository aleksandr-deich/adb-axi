import { afterEach, describe, expect, it, vi } from "vitest";
import type { FakeAdb } from "../fake-adb/harness.js";

import {
  lifecycleDevices,
  STOP_TIMEOUT_MS,
  CURRENT_USER,
  KERNEL_UIDS,
  PROCESSES,
  PACKAGE,
  FOREGROUND,
  PIDOF,
  FORCE_STOP,
  CLEAR,
  DATA_FILES,
  START,
  INSTALLED,
  PROBE_FRONT,
  PROBE_RUNNING,
  AM_START,
  both,
  shellCommands,
  expectClean,
} from "../helpers/app-lifecycle.js";

// Parity cases run two CLI deadlines sequentially, plus process startup and cleanup.
vi.setConfig({ testTimeout: 40_000 });

let fake: FakeAdb | undefined;
afterEach(() => {
  fake?.cleanup();
  fake = undefined;
});

const { device } = lifecycleDevices((value) => {
  fake = value;
});

describe("lifecycle review regressions", () => {
  it.each([0].flatMap((userId) => ["stop"].map((command) => ({ userId, command }))))(
    "keeps polling a kernel main PID after AMS removes it, user=$userId, command=$command",
    async ({ userId, command }) => {
      const otherUser = userId === 0 ? 10 : 0;
      const forceStop = FORCE_STOP.replace("--user 0", `--user ${userId}`);
      const clear = CLEAR.replace("--user 0", `--user ${userId}`);
      const start = START.replace("--user 0", `--user ${userId}`);
      const dataFiles = DATA_FILES.replace("--user 0", `--user ${userId}`);
      const f = device({
        [CURRENT_USER]: { stdout: `${userId}\n` },
        [PACKAGE]: {
          stdout:
            "Packages:\n  Package [dev.probe] (abc):\n    appId=10213\n    flags=[ DEBUGGABLE HAS_CODE ]\n    User 0: installed=true hidden=false\n    User 10: installed=true hidden=false\n",
        },
        [forceStop]: {},
        [clear]: { stdout: "Success\n" },
        [start]: AM_START.cold,
        [PIDOF]: { stdout: "8235 9001\n" },
        [KERNEL_UIDS]: {
          stdout: `  PID   UID NAME\n 8235 ${userId * 100000 + 10213} dev.probe\n 9001 ${otherUser * 100000 + 10213} dev.probe\n`,
        },
        [PROCESSES]: {},
        [FOREGROUND]: PROBE_FRONT,
        [dataFiles]: {},
      });
      const { toon, data } = await both(
        [
          "app",
          command,
          "dev.probe",
          ...(command === "start" ? ["--activity", ".MainActivity", "--fresh"] : []),
          "--timeout",
          `${STOP_TIMEOUT_MS}ms`,
        ],
        f,
      );
      expect(toon.exitCode).toBe(1);
      expect(data).toMatchObject({ code: "STOP_FAILED", last: { pid: 8235 } });
      const calls = shellCommands(f);
      expect(calls).toContain(command === "clear" ? clear : forceStop);
      expect(calls).toContain(KERNEL_UIDS);
      expect(calls).not.toContain(PROCESSES);
      expect(calls).not.toContain(start);
      expect(calls).not.toContain(dataFiles);
      expectClean(f);
    },
  );

  it.each(["PID USER\n8235 u0_a213\n"])(
    "does not guess process ownership from unreadable kernel UID output (%s)",
    async (stdout) => {
      const f = device({ [PACKAGE]: INSTALLED, [PIDOF]: PROBE_RUNNING, [KERNEL_UIDS]: { stdout } });
      const { toon, data } = await both(["app", "stop", "dev.probe"], f);
      expect(toon.exitCode).toBe(1);
      expect(data).toMatchObject({ code: "INVALID_OUTPUT", step: "reading package process names" });
      expect(shellCommands(f)).not.toContain(FORCE_STOP);
      expectClean(f);
    },
  );

  it("reports a kernel UID read refusal rather than assuming the main PID is gone", async () => {
    const f = device({
      [PACKAGE]: INSTALLED,
      [PIDOF]: PROBE_RUNNING,
      [KERNEL_UIDS]: { stderr: "Permission denied\n", exit: 1 },
    });
    const { toon, data } = await both(["app", "stop", "dev.probe"], f);
    expect(toon.exitCode).toBe(1);
    expect(data).toMatchObject({ code: "REMOTE_EXIT", step: "reading package process names" });
    expect(shellCommands(f)).not.toContain(FORCE_STOP);
    expectClean(f);
  });

  it("handles a main PID exiting between pidof and the kernel UID read", async () => {
    const f = device({
      [PACKAGE]: INSTALLED,
      [PIDOF]: PROBE_RUNNING,
      [KERNEL_UIDS]: { stdout: "  PID   UID NAME\n" },
      [FORCE_STOP]: {},
    });
    const { toon, data } = await both(["app", "stop", "dev.probe"], f);
    expect(toon.exitCode).toBe(0);
    expect(data).toEqual({ ok: "stop dev.probe -> already not running (no-op)" });
    expect(shellCommands(f)).toContain(FORCE_STOP);
    expectClean(f);
  });

  it("keeps stop's no-op and force-stop scoped when only another profile is running", async () => {
    const f = device({
      [PACKAGE]: INSTALLED,
      [PIDOF]: { stdout: "9001\n" },
      [FORCE_STOP]: {},
      [KERNEL_UIDS]: { stdout: "  PID   UID NAME\n 9001 1010213 dev.probe\n" },
    });
    const { toon, data } = await both(["app", "stop", "dev.probe"], f);
    expect(toon.exitCode).toBe(0);
    expect(data).toEqual({ ok: "stop dev.probe -> already not running (no-op)" });
    expect(shellCommands(f)).toContain(FORCE_STOP);
    expectClean(f);
  });
});
