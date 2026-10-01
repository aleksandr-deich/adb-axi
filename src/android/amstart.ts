import { parseComponent, type Component } from "./component.js";

/** How the system launched the activity; `unknown` when it did not say (or said UNKNOWN). */
export type LaunchType = "cold" | "warm" | "hot" | "unknown";

/** Why `am start` says the activity was not started, though it exits 0 (S4). */
export type NotStarted =
  /** An existing task came to the front instead of a new activity. */
  | "brought-to-front"
  /** The intent went to the instance already on top (`onNewIntent`). */
  | "delivered-to-top"
  /** The current activity was kept, or the intent went back to the caller. */
  | "kept";

export interface AmStartError {
  /** `Error type 3`: the activity class (or its package) does not exist. */
  classNotFound: boolean;
  /** The `Error:` line as printed, for a `detail` field only. */
  detail: string;
}

export interface AmStart {
  /** `Status:`; `null` when the output has none (an error, or not `-W` output). */
  status: "ok" | "timeout" | null;
  launch: LaunchType;
  notStarted: NotStarted | null;
  /** The `Activity:` the start reported. */
  activity: Component | null;
  /** `TotalTime:` in ms, the system's own measure of the launch; absent when not measured. */
  totalTimeMs: number | null;
  error: AmStartError | null;
}

/**
 * Parse `am start -W` output (AOSP `ActivityManagerShellCommand.runStartActivity` and
 * `WaitResult.launchStateToString`). Every release from API 29 to 37 prints the same lines:
 * an optional `Warning: Activity not started ...` or `Error ...`, then for a launched start
 * `Status: ok|timeout`, `LaunchState: COLD|WARM|HOT|UNKNOWN (<n>)`, `Activity:`,
 * `TotalTime:` (only when measured), `WaitTime:` and `Complete`.
 *
 * Errors are read from the text, never the exit code: API 29 exits 0 after
 * `Error type 3`, later releases exit 1. A delivered-to-top start reports
 * `LaunchState: UNKNOWN (0)`, and the idle timeout behind `Status: timeout` reports
 * `UNKNOWN (-1)`.
 */
export function parseAmStart(output: string): AmStart {
  const lines = output.split(/\r?\n/).map((line) => line.trim());
  const value = (key: string): string | undefined =>
    lines
      .find((line) => line.startsWith(`${key}: `))
      ?.slice(key.length + 2)
      .trim();

  const status = value("Status");
  const state = value("LaunchState");
  const total = value("TotalTime");
  const errorLine = lines.find(
    (line) => line.startsWith("Error: ") || /^Error type \d+$/.test(line),
  );

  return {
    status: status === "ok" || status === "timeout" ? status : null,
    launch: launchType(state),
    notStarted: notStarted(lines),
    activity: parseComponent(value("Activity") ?? ""),
    totalTimeMs: total !== undefined && /^\d+$/.test(total) ? Number(total) : null,
    error:
      errorLine === undefined
        ? null
        : {
            classNotFound: lines.includes("Error type 3"),
            detail: lines.filter((line) => line.startsWith("Error")).join(" "),
          },
  };
}

function launchType(state: string | undefined): LaunchType {
  switch (state) {
    case "COLD":
      return "cold";
    case "WARM":
      return "warm";
    case "HOT":
      return "hot";
    default:
      return "unknown";
  }
}

function notStarted(lines: readonly string[]): NotStarted | null {
  const warning = lines.find((line) => line.startsWith("Warning: Activity not started"));
  if (warning === undefined) return null;
  if (warning.includes("brought to the front")) return "brought-to-front";
  if (warning.includes("delivered to currently running top-most instance")) {
    return "delivered-to-top";
  }
  return "kept";
}

/**
 * Whether the start created the activity anew. A cold or warm launch created it, a hot one
 * resumed the existing instance. With no launch type, the "Activity not started" warning
 * is the evidence. A task brought to the front after its process died is a cold launch and
 * so a new activity, though am prints the warning too.
 */
export function wasRecreated(start: Pick<AmStart, "launch" | "notStarted">): boolean {
  if (start.launch === "cold" || start.launch === "warm") return true;
  if (start.launch === "hot") return false;
  return start.notStarted === null;
}
