import type { AdbClient } from "../../adb/run.js";
import { parseDumpsysPackage, type PackageInfo } from "../../android/packages.js";
import { pidof } from "../../android/pidof.js";
import { readShell, type ReadOptions } from "../../android/read.js";
import { AdbAxiError } from "../../core/errors.js";
import { runHint, shellWords } from "../../core/output.js";
import { poll } from "../../core/poll.js";
import type { CommandContext } from "../types.js";
import { appInstall } from "./install.js";
import { readOptions, targetSerial, UNKNOWN } from "./shared.js";

/** An installed package's record and the full `dumpsys package` text it came from. */
export interface InstalledPackage {
  info: PackageInfo;
  dump: string;
}

/**
 * Read `dumpsys package <pkg>` and require the package to be installed: no record, or a
 * record uninstalled with its data kept, is `APP_NOT_INSTALLED`.
 */
export async function requireInstalled(
  context: CommandContext,
  pkg: string,
): Promise<InstalledPackage> {
  const result = await readShell(
    context.adb(),
    targetSerial(context),
    `dumpsys package ${pkg}`,
    `reading package ${pkg}`,
    readOptions(context),
  );
  const info = parseDumpsysPackage(result.stdout, pkg);
  if (info === null || !info.installed) {
    throw new AdbAxiError("APP_NOT_INSTALLED", `${pkg} is not installed on this device`, {
      help: [
        runHint(["app", "list", "--grep", pkg.split(".").at(-1) ?? pkg], "to find the package"),
        ...(appInstall.shipped ? [runHint(["app", "install", "<apk>"], "to install it")] : []),
      ],
    });
  }
  return { info, dump: result.stdout };
}

/** `am force-stop` prints nothing and exits 0 whether or not anything was running. */
export async function forceStop(
  adb: AdbClient,
  serial: string,
  pkg: string,
  options: ReadOptions,
): Promise<void> {
  await readShell(adb, serial, `am force-stop ${pkg}`, `force-stopping ${pkg}`, options);
}

export type ExitWait = { gone: true } | { gone: false; last: number[] | null };

/**
 * Poll `pidof` until the package has no process or the command deadline passes. A read cut
 * off by the deadline ends the wait; the last full observation is the evidence.
 */
export async function waitForExit(
  adb: AdbClient,
  serial: string,
  pkg: string,
  context: CommandContext,
): Promise<ExitWait> {
  let last: number[] | null = null;
  const result = await poll({
    timeoutMs: context.deadline.remainingMs(),
    check: async () => {
      try {
        last = await pidof(adb, serial, pkg, readOptions(context));
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
  pkg: string,
  last: number[] | null,
  timeoutMs: number,
  after: StopStep,
): AdbAxiError {
  const pid =
    last === null || last.length === 0 ? UNKNOWN : last.length === 1 ? last[0] : last.join(" ");
  return new AdbAxiError(
    "STOP_FAILED",
    `${pkg} was still running at the ${formatDuration(timeoutMs)} deadline after ${after.step} in \`${shellWords(after.command)}\``,
    {
      fields: { step: after.step, last: { pid } },
      help: [
        runHint([...after.command, "--timeout", "30s"], "to give it longer"),
        runHint(["app", "info", pkg], "for its pid and foreground state"),
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
