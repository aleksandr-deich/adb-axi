import { decode } from "@toon-format/toon";
import { afterEach, describe, expect, it, vi } from "vitest";
import { allCommands, REGISTRY } from "../../src/commands/registry.js";
import type { FakeAdb } from "../fake-adb/harness.js";
import { runCli } from "../helpers/run.js";

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
  twice,
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
  it.each(
    [0, 10].flatMap((userId) => ["stop", "start", "clear"].map((command) => ({ userId, command }))),
  )(
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
          stdout: `  PID   UID\n 8235 ${userId * 100000 + 10213}\n 9001 ${otherUser * 100000 + 10213}\n`,
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

  it.each([
    "",
    "PID USER\n8235 u0_a213\n",
    "PID UID\n8235 invalid\n",
    "PID UID\n8235 9007199254740993\n",
    "PID UID\n9007199254740993 10213\n",
  ])("does not guess process ownership from unreadable kernel UID output (%s)", async (stdout) => {
    const f = device({ [PACKAGE]: INSTALLED, [PIDOF]: PROBE_RUNNING, [KERNEL_UIDS]: { stdout } });
    const { toon, data } = await both(["app", "stop", "dev.probe"], f);
    expect(toon.exitCode).toBe(1);
    expect(data).toMatchObject({ code: "INVALID_OUTPUT", step: "reading process user IDs" });
    expect(shellCommands(f)).not.toContain(FORCE_STOP);
    expectClean(f);
  });

  it("reports a kernel UID read refusal rather than assuming the main PID is gone", async () => {
    const f = device({
      [PACKAGE]: INSTALLED,
      [PIDOF]: PROBE_RUNNING,
      [KERNEL_UIDS]: { stderr: "Permission denied\n", exit: 1 },
    });
    const { toon, data } = await both(["app", "stop", "dev.probe"], f);
    expect(toon.exitCode).toBe(1);
    expect(data).toMatchObject({ code: "REMOTE_EXIT", step: "reading process user IDs" });
    expect(shellCommands(f)).not.toContain(FORCE_STOP);
    expectClean(f);
  });

  it("handles a main PID exiting between pidof and the kernel UID read", async () => {
    const f = device({
      [PACKAGE]: INSTALLED,
      [PIDOF]: PROBE_RUNNING,
      [KERNEL_UIDS]: { stdout: "  PID   UID\n" },
      [FORCE_STOP]: {},
    });
    const { toon, data } = await both(["app", "stop", "dev.probe"], f);
    expect(toon.exitCode).toBe(0);
    expect(data).toEqual({ ok: "stop dev.probe -> already not running (no-op)" });
    expect(shellCommands(f)).toEqual(
      twice([CURRENT_USER, PACKAGE, PIDOF, KERNEL_UIDS, FORCE_STOP]),
    );
    expectClean(f);
  });

  it("keeps stop's no-op and force-stop scoped when only another profile is running", async () => {
    const f = device({
      [PACKAGE]: INSTALLED,
      [PIDOF]: { stdout: "9001\n" },
      [FORCE_STOP]: {},
      [KERNEL_UIDS]: { stdout: "  PID   UID\n 9001 1010213\n" },
    });
    const { toon, data } = await both(["app", "stop", "dev.probe"], f);
    expect(toon.exitCode).toBe(0);
    expect(data).toEqual({ ok: "stop dev.probe -> already not running (no-op)" });
    expect(shellCommands(f)).toEqual(
      twice([CURRENT_USER, PACKAGE, PIDOF, KERNEL_UIDS, FORCE_STOP]),
    );
    expectClean(f);
  });
});

describe("help for the shipped app lifecycle commands", () => {
  it("lists app start, stop and clear, and no unshipped command", async () => {
    const f = device({});
    const app = decode((await runCli(["app", "--help"], f.env)).stdout.trimEnd()) as {
      subcommands: { command: string }[];
    };
    const listed = app.subcommands.map((s) => s.command);
    expect(listed).toEqual(
      expect.arrayContaining(["adb-axi app start", "adb-axi app stop", "adb-axi app clear"]),
    );
    const unshipped = allCommands(REGISTRY)
      .filter((command) => !command.shipped)
      .map((command) => `adb-axi ${command.path.join(" ")}`);
    expect(listed.filter((command) => unshipped.includes(command))).toEqual([]);
    expect(f.calls()).toEqual([]);
  });

  it("documents clear's data scope and Android's cross-user process stop", async () => {
    const f = device({});
    const { toon, data } = await both(["app", "clear", "--help"], f);
    expect(toon.exitCode).toBe(0);
    expect(data.summary).toBe(
      "Clear the current Android user's app data, verify it is cleared, and report the process stopped. Android also stops the app's running processes for other Android users, leaving their data intact.",
    );
    expect(f.calls()).toEqual([]);
  });

  it("describes the full-output escape for clear errors", async () => {
    const f = device({});
    const clear = await runCli(["app", "clear", "--help"], f.env);
    expect(clear.exitCode).toBe(0);
    expect(clear.stdout).toContain("--full");
    expect(f.calls()).toEqual([]);
  });

  it("describes app start's flags", async () => {
    const f = device({});
    const start = await runCli(["app", "start", "--help"], f.env);
    expect(start.exitCode).toBe(0);
    expect(start.stdout).toContain("--fresh");
    expect(start.stdout).toContain("--activity <name>");
    expect(start.stdout).toContain("--timeout");
    expect(f.calls()).toEqual([]);
  });
});
