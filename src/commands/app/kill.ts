import type { AdbClient } from "../../adb/run.js";
import { runShell } from "../../adb/shell.js";
import { parsePidof } from "../../android/pidof.js";
import { readForeground } from "../../android/foreground.js";
import { assertPackageName } from "../../android/component.js";
import { amKillCanKill, type Importance, type ProcessRecord } from "../../android/processes.js";
import { readRecents, findTask } from "../../android/recents.js";
import { invalidOutput, readShell } from "../../android/read.js";
import { AdbAxiError } from "../../core/errors.js";
import { noop, okLine, runHint, type Output } from "../../core/output.js";
import { poll } from "../../core/poll.js";
import { defineCommand } from "../define.js";
import type { CommandContext } from "../types.js";
import {
  formatDuration,
  lifecycleCommand,
  packageProcesses,
  requireInstalled,
  type InstalledPackage,
} from "./process.js";
import { readOptions, targetSerial, UNKNOWN } from "./shared.js";

/**
 * How long `am kill` gets to take the process down before a debuggable app is killed
 * through `run-as`. `am kill` ends a killable process within about 50 ms (E0).
 */
const KILL_WINDOW_MS = 2000;

export const appKill = defineCommand({
  path: ["app", "kill"],
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
  /** The main process's pid before the kill; several pids print space-separated. */
  pidBefore: number | string;
  backgroundedFirst: boolean;
  /** Time from the app leaving the front until the system rated it killable by `am kill`. */
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
 * poll its oom adj until `am kill` can act on it, kill, verify with `pidof` that the main
 * process is gone, and confirm the task stayed in recents. `command` is what hints name
 * to retry. A process that is not running is `killed: false`.
 */
export async function killProcess(
  context: CommandContext,
  pkg: string,
  installed: InstalledPackage,
  command: string[],
): Promise<KillResult> {
  const adb = context.adb();
  const serial = targetSerial(context);
  const { userId } = installed;
  const options = readOptions(context);
  const uid = installed.info.uid;
  if (uid === null) throw invalidOutput(`reading package ${pkg}`, installed.dump);

  const before = await packagePids(context, pkg, uid);
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

  const killable = await awaitKillable(context, pkg, userId);
  if (!killable.ok) throw killTimeout(context, pkg, killable.last, false, command);
  const cachedAfterMs = backgroundedFirst
    ? Math.round(performance.now() - backgroundedAt)
    : killable.waitedMs;

  await readShell(adb, serial, `am kill --user ${userId} ${pkg}`, `killing ${pkg}`, options);

  let method: KillEvidence["method"] = "am kill";
  let exit = await awaitGone(
    context,
    pkg,
    userId,
    uid,
    installed.info.debuggable
      ? Math.min(KILL_WINDOW_MS, context.deadline.remainingMs())
      : context.deadline.remainingMs(),
  );
  if (!exit.gone && installed.info.debuggable && context.deadline.remainingMs() > 0) {
    await runAsKill(adb, serial, pkg, userId, exit.last?.pids ?? before, context);
    method = "run-as kill";
    exit = await awaitGone(context, pkg, userId, uid, context.deadline.remainingMs());
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
async function awaitKillable(
  context: CommandContext,
  pkg: string,
  userId: number,
): Promise<Killable> {
  let last: Seen | undefined;
  const result = await poll<null, Seen>({
    timeoutMs: context.deadline.remainingMs(),
    check: async () => {
      let processes: ProcessRecord[];
      try {
        processes = await packageProcesses(context, pkg, userId, readOptions(context));
      } catch (error) {
        if (error instanceof AdbAxiError && error.code === "TIMEOUT") {
          return last === undefined ? { done: false, last: seenNothing() } : { done: false, last };
        }
        throw error;
      }
      const main = processes.find((process) => process.process === pkg);
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

async function packagePids(context: CommandContext, pkg: string, uid: number): Promise<number[]> {
  const result = await readShell(
    context.adb(), targetSerial(context), "ps -A -o PID,UID,NAME",
    "reading package process names", readOptions(context),
  );
  const lines = result.stdout.trim().split(/\r?\n/);
  if (lines.shift()?.trim().replace(/\s+/g, " ") !== "PID UID NAME") {
    throw invalidOutput("reading package process names", result.stdout);
  }
  const names = new Map<string, Set<number>>();
  for (const line of lines) {
    const row = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
    if (!row || !Number.isSafeInteger(Number(row[1])) || !Number.isSafeInteger(Number(row[2]))) {
      throw invalidOutput("reading package process names", result.stdout);
    }
    const [pid, rowUid, name] = [Number(row[1]), Number(row[2]), row[3] as string];
    if (pid <= 0 || rowUid !== uid) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(name)) {
      throw invalidOutput("reading package process names", result.stdout);
    }
    const known = names.get(name) ?? new Set<number>();
    known.add(pid);
    names.set(name, known);
  }
  const pids: number[] = [];
  if (!names.has(pkg)) names.set(pkg, new Set());
  for (const [name, known] of names) {
    const check = await readShell(
      context.adb(), targetSerial(context), `pidof ${name}`,
      `reading the pid of ${name}`, readOptions(context), [0, 1],
    );
    const running = parsePidof(check.stdout);
    if (running === null || (check.exitCode === 1) !== (running.length === 0)) {
      throw invalidOutput(`reading the pid of ${name}`, check.stdout);
    }
    pids.push(...running.filter((pid) => known.has(pid)));
  }
  return pids;
}


/**
 * Poll `pidof` (the exit evidence; an ActivityManager record can vanish before its
 * process does) until the main process is gone or `windowMs` passes. A process still
 * alive is read once more from ActivityManager so the timeout can name its state.
 */
async function awaitGone(
  context: CommandContext,
  pkg: string,
  userId: number,
  uid: number,
  windowMs: number,
): Promise<Gone> {
  let last: Seen | undefined;
  const result = await poll<null, Seen | undefined>({
    timeoutMs: windowMs,
    check: async () => {
      try {
        const pids = await packagePids(context, pkg, uid);
        if (pids.length === 0) return { done: true, value: null };
        const processes = await packageProcesses(context, pkg, userId, readOptions(context));
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
  context: CommandContext,
): Promise<void> {
  await runShell(adb, serial, `run-as ${pkg} --user ${userId} kill -9 ${pids.join(" ")}`, {
    deadline: context.deadline,
    step: `killing ${pkg} through run-as`,
  });
}

/** `KILL_TIMEOUT`: the process was still alive at the deadline, in the state last seen. */
function killTimeout(
  context: CommandContext,
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
function taskGone(context: CommandContext, pkg: string, evidence: KillEvidence): AdbAxiError {
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
