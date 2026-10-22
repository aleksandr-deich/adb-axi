import type { AdbClient } from "../../adb/run.js";
import { identityOf, runningProcesses, type AppIdentity } from "../../android/app-processes.js";
import { readPackageSnapshot, type PackageInfo } from "../../android/packages.js";
import { readCurrentUser } from "../../android/users.js";
import { readShell, type ReadOptions } from "../../android/read.js";
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
  app: AppIdentity;
}

export function lifecycleCommand(context: CommandContext, args: string[]): string[] {
  const device = context.flags.device ?? context.env.ANDROID_SERIAL;
  return typeof device === "string" && device !== "" ? [...args, "--device", device] : args;
}

/**
 * Resolve the current Android user once and require installation for that user. No
 * package record, an absent/uninstalled user record, or no installed code is `APP_NOT_INSTALLED`.
 * The returned user ID scopes subsequent mutations and observations even if users switch.
 */
export async function requireInstalled(
  context: CommandContext,
  pkg: string,
): Promise<InstalledPackage> {
  const userId = await readCurrentUser(context.adb(), targetSerial(context), readOptions(context));
  const { info, dump } = await readPackageSnapshot(
    context.adb(),
    targetSerial(context),
    pkg,
    readOptions(context),
    userId,
  );
  if (info === null || !info.installed) throw notInstalled(context, pkg);
  return { info, dump, userId, app: identityOf(info, dump) };
}

/** `APP_NOT_INSTALLED`, with hints to find the package or install it. */
export function notInstalled(context: CommandContext, pkg: string): AdbAxiError {
  return new AdbAxiError("APP_NOT_INSTALLED", `${pkg} is not installed on this device`, {
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

/** The pids of every running process of the app. */
export async function appPids(context: CommandContext, app: AppIdentity): Promise<number[]> {
  const processes = await runningProcesses(
    context.adb(),
    targetSerial(context),
    app,
    readOptions(context),
  );
  return processes.map(({ pid }) => pid);
}

/**
 * Poll until every process of the app is gone or the command deadline passes: force-stop
 * and `pm clear` end them all. A read cut off by the deadline ends the wait; the last full
 * observation is the evidence.
 */
export async function waitForExit(context: CommandContext, app: AppIdentity): Promise<ExitWait> {
  let last: number[] | null = null;
  const result = await poll({
    timeoutMs: context.deadline.remainingMs(),
    check: async () => {
      try {
        last = await appPids(context, app);
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
