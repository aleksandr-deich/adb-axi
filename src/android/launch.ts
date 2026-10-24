import { runShell } from "../adb/shell.js";
import { Deadline } from "../core/deadline.js";
import { AdbAxiError } from "../core/errors.js";
import { observe, poll, realClock } from "../core/poll.js";
import type { DeviceSession } from "../device/session.js";
import { readActivityProcessName } from "./activities.js";
import { parseAmStart, type AmStart } from "./amstart.js";
import {
  runningProcesses,
  userIdFromUid,
  type AppIdentity,
  type RunningProcess,
} from "./app-processes.js";
import type { ActivityRecord, Component } from "./component.js";
import { readForeground } from "./foreground.js";
import { readLaunchCrashes, type LaunchCrash, type LaunchProcess } from "./launch-crash.js";
import { invalidOutput } from "./read.js";

const SETTLE_MS = 2000;

export interface Seen {
  state: "foreground" | "running" | "stopped" | "crashed";
  pid: number | "-";
  front: ActivityRecord | null;
}

export interface LaunchDeath {
  status: "died";
  launched: Component;
  processName: string;
  settled: Seen;
}

export interface LaunchStarted {
  status: "started";
  start: AmStart;
  launched: Component;
  processName: string;
  settled: Seen & { pid: number };
  before: readonly RunningProcess[];
}

export interface LaunchTimeout {
  status: "timeout";
  last: { status: "timeout" | "no answer"; activity: string };
}

export type LaunchResult = LaunchStarted | LaunchDeath | LaunchTimeout;

export async function launch(
  device: DeviceSession,
  app: AppIdentity,
  component: Component,
): Promise<LaunchResult> {
  const before = await runningProcesses(device.adb, device.serial, app, device.reads);
  const prelaunch = before.map(({ pid, name }) => ({ pid, process: name, uid: app.uid }));
  const baseline = new Set(
    (await readLaunchCrashes(device.adb, device.serial, device.reads, prelaunch)).keys,
  );
  const watch = new LaunchWatch(device, app, baseline, prelaunch);
  const userId = userIdFromUid(app.uid);
  const result = await watch.during(
    (signal) => amStart(device, component, userId, signal),
    async (crash, signal) => {
      const processName = await readActivityProcessName(
        device.adb,
        device.serial,
        component,
        userId,
        {
          ...device.reads,
          signal,
        },
      );
      return crash.process === processName
        ? {
            status: "died",
            launched: component,
            processName,
            settled: { state: "crashed", pid: crash.pid, front: null },
          }
        : null;
    },
  );
  if (result.status !== "started") return result;
  const { start } = result;
  const launched = start.activity ?? component;
  const processName = await readActivityProcessName(
    device.adb,
    device.serial,
    launched,
    userId,
    device.reads,
  );
  const settled = await settle(device, app, launched, processName, watch);
  if (settled.state === "crashed" || settled.pid === "-") {
    return { status: "died", launched, processName, settled };
  }
  return {
    status: "started",
    start,
    launched,
    processName,
    settled: { ...settled, pid: settled.pid },
    before,
  };
}

async function amStart(
  device: DeviceSession,
  component: Component,
  userId: number,
  signal: AbortSignal,
): Promise<{ status: "started"; start: AmStart } | LaunchTimeout> {
  const step = `starting ${component.component}`;
  let output: string;
  let exitCode: number;
  try {
    // Single quotes keep a nested class's `$` away from the device shell.
    const result = await runShell(
      device.adb,
      device.serial,
      `am start --user ${userId} -W -n '${component.component}'`,
      { ...device.reads, step, signal },
    );
    output = `${result.stdout}\n${result.stderr}`;
    exitCode = result.exitCode;
  } catch (error) {
    if (error instanceof AdbAxiError && error.code === "TIMEOUT") {
      return { status: "timeout", last: { status: "no answer", activity: component.activity } };
    }
    throw error;
  }
  const start = parseAmStart(output);
  if (start.error?.classNotFound === true) {
    throw new AdbAxiError(
      "ACTIVITY_NOT_FOUND",
      `${component.package} has no activity ${component.activity}`,
    );
  }
  if (start.error !== null || exitCode !== 0) {
    throw new AdbAxiError("REMOTE_EXIT", `${step} failed: the activity manager refused it`, {
      fields: { step, exit: exitCode, detail: start.error?.detail ?? output.trim().slice(0, 200) },
    });
  }
  if (start.status === null) throw invalidOutput(step, output);
  if (start.status === "timeout") {
    return {
      status: "timeout",
      last: { status: "timeout", activity: start.activity?.activity ?? component.activity },
    };
  }
  // am can report a permission dialog instead of the requested app's activity.
  return {
    status: "started",
    start: {
      ...start,
      activity: start.activity?.package === component.package ? start.activity : null,
    },
  };
}

async function settle(
  device: DeviceSession,
  app: AppIdentity,
  activity: Component,
  processName: string,
  watch: LaunchWatch,
): Promise<Seen> {
  const deadline = new Deadline(Math.min(SETTLE_MS, device.reads.deadline.remainingMs()));
  let first = true;
  const result = await observe<Seen>({
    deadline,
    requireObservation: true,
    read: async (nextDeadline) => {
      // The first complete observation gets the command budget even on a slow device.
      const reads = first ? device.reads : { deadline: nextDeadline };
      const crash = (await watch.check(reads)).find((entry) => entry.process === processName);
      if (crash !== undefined) return { state: "crashed", pid: crash.pid, front: null };
      // ActivityManager can discard its record before the kernel process exits.
      const processes = await runningProcesses(device.adb, device.serial, app, reads);
      const front = await readForeground(device.adb, device.serial, {
        ...reads,
        userId: userIdFromUid(app.uid),
      });
      const pid = processes.find((process) => process.name === processName)?.pid ?? "-";
      const state =
        pid === "-" ? "stopped" : front?.package === activity.package ? "foreground" : "running";
      first = false;
      return { state, pid, front };
    },
    done: (seen) => seen.state !== "running",
  });
  // requireObservation propagates an initial TIMEOUT, so a completed poll has evidence.
  return result.ok ? result.value : (result.last as Seen);
}

class LaunchWatch {
  constructor(
    private readonly device: DeviceSession,
    private readonly app: AppIdentity,
    private readonly baseline: ReadonlySet<string>,
    private readonly prelaunch: readonly LaunchProcess[],
  ) {}

  async check(reads = this.device.reads): Promise<LaunchCrash[]> {
    const { crashes } = await readLaunchCrashes(
      this.device.adb,
      this.device.serial,
      reads,
      this.prelaunch,
    );
    return crashes.filter(
      (crash) =>
        crash.uid === this.app.uid &&
        crash.userId === userIdFromUid(this.app.uid) &&
        !this.baseline.has(crash.key),
    );
  }

  async during<T>(
    start: (signal: AbortSignal) => Promise<T>,
    died: (crash: LaunchCrash, signal: AbortSignal) => Promise<LaunchDeath | null>,
  ): Promise<T | LaunchDeath> {
    const controller = new AbortController();
    const signal = controller.signal;
    const starting = start(signal);
    const monitoring = (async (): Promise<T | LaunchDeath> => {
      try {
        const result = await poll<LaunchDeath, null>({
          timeoutMs: this.device.reads.deadline.remainingMs(),
          clock: { now: () => realClock.now(), sleep: (ms) => realClock.sleep(ms, signal) },
          check: async () => {
            signal.throwIfAborted();
            for (const crash of await this.check({ ...this.device.reads, signal })) {
              signal.throwIfAborted();
              const death = await died(crash, signal);
              if (death !== null) return { done: true, value: death };
            }
            return { done: false, last: null };
          },
        });
        return result.ok ? result.value : await starting;
      } catch (error) {
        if (error instanceof AdbAxiError && error.code === "TIMEOUT") return starting;
        throw error;
      }
    })();
    try {
      return await Promise.race([starting, monitoring]);
    } finally {
      controller.abort();
      await Promise.allSettled([starting, monitoring]);
    }
  }
}
