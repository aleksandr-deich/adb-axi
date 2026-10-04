import { homedir } from "node:os";
import { AdbAxiError } from "../../core/errors.js";

export const CHECK_NAMES = [
  "adb",
  "server",
  "device",
  "boot",
  "clock",
  "data_free",
  "animations",
  "ime",
  "instrumentation",
  "console_token",
] as const;
export type CheckName = (typeof CHECK_NAMES)[number];
export type CheckStatus = "ok" | "warn" | "failed";

/** One row of the report. `help` is next steps for the whole report, never printed in the row. */
export interface CheckResult {
  check: CheckName;
  status: CheckStatus;
  detail: string;
  help: readonly string[];
}

export function ok(check: CheckName, detail: string): CheckResult {
  return { check, status: "ok", detail, help: [] };
}

export function warn(check: CheckName, detail: string, help: readonly string[] = []): CheckResult {
  return { check, status: "warn", detail, help };
}

export function failed(
  check: CheckName,
  detail: string,
  help: readonly string[] = [],
): CheckResult {
  return { check, status: "failed", detail, help };
}

/** One line: a row's detail never spans lines, whatever the device printed. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The user's home directory collapsed to `~`, as the home view prints paths. */
export function tildePath(path: string, home: string = homedir()): string {
  return home !== "" && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** Errors that mean the thing a check looks at did not answer: a finding, not an abort. */
const UNANSWERED = new Set([
  "TIMEOUT",
  "ADB_NOT_FOUND",
  "ADB_SERVER_UNREACHABLE",
  "DEVICE_NOT_FOUND",
  "DEVICE_OFFLINE",
  "DEVICE_UNAUTHORIZED",
]);

/** Errors that mean the check ran but could not read what it found. */
const UNREADABLE = new Set(["REMOTE_EXIT", "INVALID_OUTPUT"]);

/**
 * Run one check. A device that does not answer is `failed` (that is what doctor is for) and
 * output a check cannot read is `warn`; both keep the report going. Any other error is an
 * adb-axi bug and ends the command.
 */
export async function settle(
  check: CheckName,
  run: () => Promise<CheckResult>,
): Promise<CheckResult> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof AdbAxiError)) throw error;
    if (UNANSWERED.has(error.code)) return failed(check, oneLine(error.message));
    if (UNREADABLE.has(error.code)) {
      return warn(check, `could not read it: ${oneLine(error.message)}`);
    }
    throw error;
  }
}
