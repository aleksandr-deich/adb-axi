import type { AdbClient } from "../../adb/run.js";
import { runShell } from "../../adb/shell.js";
import {
  amKillCanKill,
  mainProcess,
  processImportance,
  runningProcesses,
  type AppIdentity,
  type ProcessRecord,
} from "../../android/app-processes.js";
import { readForeground } from "../../android/foreground.js";
import { assertPackageName } from "../../android/component.js";
import type { Importance } from "../../android/processes.js";
import { readRecents, findTask } from "../../android/recents.js";
import { readShell } from "../../android/read.js";
import { AdbAxiError } from "../../core/errors.js";
import { noop, okLine, runHint, type Output } from "../../core/output.js";
import { poll } from "../../core/poll.js";
import { defineCommand } from "../define.js";
import type { DeviceContext } from "../types.js";
import {
  formatDuration,
  lifecycleCommand,
  requireInstalled,
  type InstalledPackage,
} from "./process.js";
import { UNKNOWN } from "./shared.js";

/**
 * How long `am kill` gets to take the process down before a debuggable app is killed
 * through `run-as`. `am kill` ends a killable process within about 50 ms (E0).
 */
const KILL_WINDOW_MS = 2000;

export const appKill = defineCommand({
  path: ["app", "kill"],
  help: [
    "Targets the current Android user",
    "Processes are matched by the app's uid, so other packages that share it are included and isolated services, which run under their own uid, are not",
  ],
  summary:
    "Kill an app's process the way the system does, keeping its task in recents. An app in front is sent to the background first (HOME), which changes what is on screen, and Android kills the app's other background processes with it.",
  positionals: [
    { name: "pkg", description: "Package name, for example com.example.notes", required: true },
  ],
  examples: [
    "adb-axi app kill com.example.notes",
    "adb-axi app kill com.example.notes --timeout 20s",
  ],
  shipped: true,
  run: async (context) => {
    const pkg = String(context.positionals.pkg);
    assertPackageName(pkg);
    const installed = await requireInstalled(context, pkg);
    const command = lifecycleCommand(context, ["app", "kill", pkg]);
    const result = await killProcess(context, pkg, installed, command);
    if (!result.killed) {
      return { ok: okLine("kill", pkg, noop("already not running")) };
    }
    return {
      ok: okLine("kill", pkg, "process gone, task kept in recents"),
      kill: killRecord(result.evidence),
      help: [
        ...(context.isShipped(["app", "restore"])
          ? [
              runHint(
                lifecycleCommand(context, ["app", "restore", pkg]),
                "to reopen it from recents",
              ),
            ]
          : []),
        ...(context.isShipped(["logs"])
          ? [
              runHint(
                lifecycleCommand(context, ["logs", "--pkg", pkg, "--since", "30s"]),
                "to see what it logged while dying",
              ),
            ]
          : []),
      ],
    } satisfies Output;
  },
});

/** What a kill proved, for the `kill` block of `app kill` and the evidence `app death` keeps. */
export interface KillEvidence {
  /** Pids found under the package UID before the kill; several print space-separated. */
  pidBefore: number | string;
  backgroundedFirst: boolean;
  /** Wait for a killable oom adj, measured from HOME when the app was in front. */
  cachedAfterMs: number;
  method: "am kill" | "run-as kill";
}

export type KillResult = { killed: false } | { killed: true; evidence: KillEvidence };

/** The `kill` block as `app kill` prints it; the pid is verified gone, so `pid_after` is null. */
export function killRecord(evidence: KillEvidence): Record<string, unknown> {
  return {
    pid_before: evidence.pidBefore,
    pid_after: null,
    backgrounded_first: evidence.backgroundedFirst,
    cached_after_ms: evidence.cachedAfterMs,
    method: evidence.method,
  };
}

/** A pid field: the pid, `null` for none, the pids space-separated for several. */
export function pidValue(pids: readonly number[]): number | string | null {
  if (pids.length === 0) return null;
  return pids.length === 1 ? (pids[0] ?? null) : pids.join(" ");
}

/** One observation of the main process: what the kill timeout reports as the state it was in. */
interface Seen {
  pids: number[];
  state: Importance | typeof UNKNOWN;
  adj: number | null;
}

/**
 * The process-death probe (S5, L5). `am kill` silently does nothing to a process the
 * system rates as important, so the sequence is: send an app in front to the background,
 * poll its oom adj until `am kill` can act on it, kill, verify with `pidof` that the
 * observed UID processes are gone, and confirm the task stayed in recents. `command`
 * is what hints name to retry. A process that is not running is `killed: false`.
 */
export async function killProcess(
  context: DeviceContext,
  pkg: string,
  installed: InstalledPackage,
  command: string[],
): Promise<KillResult> {
  const adb = context.device.adb;
  const serial = context.device.serial;
  const { userId, app } = installed;
  const options = context.device.reads;

  const before = (await runningProcesses(adb, serial, app, options)).map(({ pid }) => pid);
  if (before.length === 0) return { killed: false };

  const front = await readForeground(adb, serial, { ...options, userId });
  const backgroundedFirst = front?.package === pkg;
  const backgroundedAt = performance.now();
  if (backgroundedFirst) {
    await readShell(
      adb,
      serial,
      "input keyevent KEYCODE_HOME",
      `sending ${pkg} to the background`,
      options,
    );
  }

  const killable = await awaitKillable(context, app);
  if (!killable.ok) throw killTimeout(context, pkg, killable.last, false, command);
  const cachedAfterMs = backgroundedFirst
    ? Math.round(performance.now() - backgroundedAt)
    : killable.waitedMs;

  await readShell(adb, serial, `am kill --user ${userId} ${pkg}`, `killing ${pkg}`, options);

  let method: KillEvidence["method"] = "am kill";
  let exit = await awaitGone(
    context,
    app,
    installed.info.debuggable
      ? Math.min(KILL_WINDOW_MS, context.deadline.remainingMs())
      : context.deadline.remainingMs(),
  );
  if (!exit.gone && installed.info.debuggable && context.deadline.remainingMs() > 0) {
    await runAsKill(adb, serial, pkg, userId, exit.last?.pids ?? before, context);
    method = "run-as kill";
    exit = await awaitGone(context, app, context.deadline.remainingMs());
  }
  if (!exit.gone) throw killTimeout(context, pkg, exit.last, true, command);

  const evidence: KillEvidence = {
    pidBefore: pidValue(before) ?? UNKNOWN,
    backgroundedFirst,
    cachedAfterMs,
    method,
  };
  const tasks = await readRecents(adb, serial, options);
  if (findTask(tasks, pkg, userId) === undefined) throw taskGone(context, pkg, evidence);
  return { killed: true, evidence };
}

type Killable = { ok: true; waitedMs: number } | { ok: false; last: Seen | undefined };

/**
 * Poll the main process's oom adj until it is high enough for `am kill` (E0: the
 * previous app qualifies, so on API 35, where an app never becomes `cached` while the
 * launcher stays up, this still ends). A process with no record, or whose adj the dump
 * does not print, is left to the kill and the `pidof` check that follows it.
 */
async function awaitKillable(context: DeviceContext, app: AppIdentity): Promise<Killable> {
  let last: Seen | undefined;
  const result = await poll<null, Seen>({
    timeoutMs: context.deadline.remainingMs(),
    check: async () => {
      let processes: ProcessRecord[];
      try {
        processes = await processImportance(
          context.device.adb,
          context.device.serial,
          app,
          context.device.reads,
        );
      } catch (error) {
        if (error instanceof AdbAxiError && error.code === "TIMEOUT") {
          return last === undefined ? { done: false, last: seenNothing() } : { done: false, last };
        }
        throw error;
      }
      const main = mainProcess(app, processes);
      if (main === undefined || main.adj === null || amKillCanKill(main.adj)) {
        return { done: true, value: null };
      }
      last = seen(main, [main.pid]);
      return { done: false, last };
    },
  });
  return result.ok ? { ok: true, waitedMs: result.waitedMs } : { ok: false, last: result.last };
}

type Gone = { gone: true } | { gone: false; last: Seen | undefined };

/**
 * Poll `pidof` (the exit evidence; an ActivityManager record can vanish before its
 * process does) until the observed UID processes are gone or `windowMs` passes.
 * A process still alive is read once more from ActivityManager for the timeout state.
 */
async function awaitGone(
  context: DeviceContext,
  app: AppIdentity,
  windowMs: number,
): Promise<Gone> {
  const adb = context.device.adb;
  const serial = context.device.serial;
  let last: Seen | undefined;
  const result = await poll<null, Seen | undefined>({
    timeoutMs: windowMs,
    check: async () => {
      try {
        const pids = (await runningProcesses(adb, serial, app, context.device.reads)).map(
          ({ pid }) => pid,
        );
        if (pids.length === 0) return { done: true, value: null };
        const processes = await processImportance(adb, serial, app, context.device.reads);
        const main = processes.find((process) => process.pid === pids[0]);
        last = main === undefined ? { pids, state: UNKNOWN, adj: null } : seen(main, pids);
      } catch (error) {
        if (!(error instanceof AdbAxiError && error.code === "TIMEOUT")) throw error;
      }
      return { done: false, last };
    },
  });
  return result.ok ? { gone: true } : { gone: false, last: result.last };
}

function seen(record: ProcessRecord, pids: number[]): Seen {
  return { pids, state: record.importance ?? UNKNOWN, adj: record.adj };
}

function seenNothing(): Seen {
  return { pids: [], state: UNKNOWN, adj: null };
}

/**
 * Kill the process as the app itself, for a debuggable app that outlived `am kill`.
 * The exit code is not read: the pid check that follows decides, and `kill` exits 1
 * when the process died in the meantime.
 */
async function runAsKill(
  adb: AdbClient,
  serial: string,
  pkg: string,
  userId: number,
  pids: readonly number[],
  context: DeviceContext,
): Promise<void> {
  await runShell(adb, serial, `run-as ${pkg} --user ${userId} kill -9 ${pids.join(" ")}`, {
    deadline: context.deadline,
    step: `killing ${pkg} through run-as`,
  });
}

/** `KILL_TIMEOUT`: the process was still alive at the deadline, in the state last seen. */
function killTimeout(
  context: DeviceContext,
  pkg: string,
  last: Seen | undefined,
  amKillSent: boolean,
  command: string[],
): AdbAxiError {
  const state = last ?? seenNothing();
  const described =
    state.adj === null ? `state ${state.state}` : `${state.state}, oom adj ${state.adj}`;
  return new AdbAxiError(
    "KILL_TIMEOUT",
    amKillSent
      ? `${pkg} was still alive at the ${formatDuration(context.timeoutMs)} deadline after am kill (${described})`
      : `${pkg} never reached a state am kill can act on within ${formatDuration(context.timeoutMs)} (${described})`,
    {
      fields: {
        last: {
          pid: pidValue(state.pids) ?? UNKNOWN,
          state: state.state,
          adj: state.adj ?? UNKNOWN,
        },
        am_kill_sent: amKillSent,
      },
      help: [
        runHint([...command, "--timeout", "30s"], "to give it longer"),
        runHint(
          lifecycleCommand(context, ["app", "info", pkg]),
          "for its pid and foreground state",
        ),
      ],
    },
  );
}

/** `TASK_NOT_IN_RECENTS` after a kill: the process is gone, but there is nothing to restore. */
function taskGone(context: DeviceContext, pkg: string, evidence: KillEvidence): AdbAxiError {
  return new AdbAxiError(
    "TASK_NOT_IN_RECENTS",
    `${pkg} was killed but its task is not in recents, so a restore would be a fresh launch`,
    {
      fields: { kill: killRecord(evidence) },
      help: context.isShipped(["app", "start"])
        ? [runHint(lifecycleCommand(context, ["app", "start", pkg]), "to start it fresh")]
        : [],
    },
  );
}
