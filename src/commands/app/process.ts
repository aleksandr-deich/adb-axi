import type { AdbClient } from "../../adb/run.js";
import { parseDumpsysPackage, type PackageInfo } from "../../android/packages.js";
import { pidof } from "../../android/pidof.js";
import { readProcesses, type ProcessRecord } from "../../android/processes.js";
import { invalidOutput, readShell, type ReadOptions } from "../../android/read.js";
import { AdbAxiError } from "../../core/errors.js";
import { commandLine, runHint } from "../../core/output.js";
import { poll } from "../../core/poll.js";
import type { CommandContext } from "../types.js";
import { appInstall } from "./install.js";
import { readOptions, targetSerial, UNKNOWN } from "./shared.js";

/** An installed package's record and the full `dumpsys package` text it came from. */
export interface InstalledPackage {
  info: PackageInfo;
  dump: string;
  userId: number;
}

export function lifecycleCommand(context: CommandContext, args: string[]): string[] {
  const device = context.flags.device ?? context.env.ANDROID_SERIAL;
  return typeof device === "string" && device !== "" ? [...args, "--device", device] : args;
}

export async function packageProcesses(
  context: CommandContext,
  pkg: string,
  userId: number,
  options: ReadOptions,
): Promise<ProcessRecord[]> {
  const processes = await readProcesses(context.adb(), targetSerial(context), pkg, options);
  return processes.filter((process) => Math.floor(process.uid / 100000) === userId);
}

export async function mainPids(
  context: CommandContext,
  pkg: string,
  userId: number,
): Promise<number[]> {
  const pids = await pidof(context.adb(), targetSerial(context), pkg, readOptions(context));
  if (pids.length === 0) return pids;
  const step = "reading process user IDs";
  const result = await readShell(
    context.adb(),
    targetSerial(context),
    "ps -A -o PID,UID",
    step,
    readOptions(context),
  );
  const [header, ...lines] = result.stdout.trim().split(/\r?\n/);
  if (header?.trim().replace(/\s+/g, " ") !== "PID UID") {
    throw invalidOutput(step, result.stdout);
  }
  const uids = new Map<number, number>();
  for (const line of lines) {
    const row = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    const pid = Number(row?.[1]);
    const uid = Number(row?.[2]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(uid)) {
      throw invalidOutput(step, result.stdout);
    }
    uids.set(pid, uid);
  }
  return pids.filter((pid) => {
    const uid = uids.get(pid);
    return uid !== undefined && Math.floor(uid / 100000) === userId;
  });
}

/**
 * Resolve the current Android user once and require installation for that user. No
 * package record, an absent user record, or an uninstalled record is `APP_NOT_INSTALLED`.
 * The returned user ID scopes subsequent mutations and observations even if users switch.
 */
export async function requireInstalled(
  context: CommandContext,
  pkg: string,
): Promise<InstalledPackage> {
  const current = await readShell(
    context.adb(),
    targetSerial(context),
    "am get-current-user",
    "reading the current Android user",
    readOptions(context),
  );
  const user = current.stdout.trim();
  if (!/^\d+$/.test(user) || !Number.isSafeInteger(Number(user))) {
    throw invalidOutput("reading the current Android user", current.stdout);
  }
  const userId = Number(user);
  const result = await readShell(
    context.adb(),
    targetSerial(context),
    `dumpsys package ${pkg}`,
    `reading package ${pkg}`,
    readOptions(context),
  );
  const info = parseDumpsysPackage(result.stdout, pkg, userId);
  if (info === null || !info.installed) {
    throw new AdbAxiError("APP_NOT_INSTALLED", `${pkg} is not installed on this device`, {
      help: [
        runHint(
          lifecycleCommand(context, ["app", "list", "--grep", pkg.split(".").at(-1) ?? pkg]),
          "to find the package",
        ),
        ...(appInstall.shipped
          ? [runHint(lifecycleCommand(context, ["app", "install", "<apk>"]), "to install it")]
          : []),
      ],
    });
  }
  return { info, dump: result.stdout, userId };
}

/** `am force-stop` prints nothing and exits 0 whether or not anything was running. */
export async function forceStop(
  adb: AdbClient,
  serial: string,
  pkg: string,
  userId: number,
  options: ReadOptions,
): Promise<void> {
  await readShell(
    adb,
    serial,
    `am force-stop --user ${userId} ${pkg}`,
    `force-stopping ${pkg}`,
    options,
  );
}

export type ExitWait = { gone: true } | { gone: false; last: number[] | null };

/**
 * Poll main PIDs from `pidof`, scoped by kernel-backed `ps` UIDs, until none remain for
 * the selected user or the command deadline passes. ActivityManager membership is not
 * exit evidence: its record can disappear before the process dies. A read cut off by
 * the deadline ends the wait; the last full observation is the evidence.
 */
export async function waitForExit(
  context: CommandContext,
  pkg: string,
  userId: number,
): Promise<ExitWait> {
  let last: number[] | null = null;
  const result = await poll({
    timeoutMs: context.deadline.remainingMs(),
    check: async () => {
      try {
        last = await mainPids(context, pkg, userId);
      } catch (error) {
        if (error instanceof AdbAxiError && error.code === "TIMEOUT") {
          return { done: false, last };
        }
        throw error;
      }
      return last.length === 0 ? { done: true, value: null } : { done: false, last };
    },
  });
  return result.ok ? { gone: true } : { gone: false, last };
}

/** The command a stop belongs to, and the step after which the process had to be gone. */
export interface StopStep {
  command: string[];
  step: "am force-stop" | "pm clear";
}

/** `STOP_FAILED`: the process outlived the step's deadline. */
export function stopFailed(
  context: CommandContext,
  pkg: string,
  last: number[] | null,
  timeoutMs: number,
  after: StopStep,
): AdbAxiError {
  const pid =
    last === null || last.length === 0 ? UNKNOWN : last.length === 1 ? last[0] : last.join(" ");
  return new AdbAxiError(
    "STOP_FAILED",
    `${pkg} was still running at the ${formatDuration(timeoutMs)} deadline after ${after.step} in \`${commandLine(after.command)}\``,
    {
      fields: { last: { pid } },
      help: [
        runHint([...after.command, "--timeout", "30s"], "to give it longer"),
        runHint(
          lifecycleCommand(context, ["app", "info", pkg]),
          "for its pid and foreground state",
        ),
      ],
    },
  );
}

/** Pids as the ok line names them: `pid 5120`, `pids 5120 5121`. */
export function pidLabel(pids: readonly number[]): string {
  return `${pids.length === 1 ? "pid" : "pids"} ${pids.join(" ")}`;
}

export function formatDuration(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`;
}
