import { join } from "node:path";
import { isPackageName } from "../../android/component.js";
import type { ProcessName } from "../../android/ps.js";
import { parseDuration } from "../../core/args.js";
import { AdbAxiError } from "../../core/errors.js";
import { runHint } from "../../core/output.js";
import { deviceStateDir, readJson, writeJsonAtomic } from "../../core/state.js";

/** A device-clock time stored under a name for one device. */
export interface Mark {
  /** The device's wall clock when the mark was taken, in epoch milliseconds. */
  epochMs: number;
  /** The device's UTC offset in minutes, or `null` when it printed none. */
  utcOffsetMinutes: number | null;
  /**
   * The app processes running when the mark was taken. Only recorded on API 29 and 30,
   * where `logs --pkg` falls back to a pid list.
   */
  processes: ProcessName[];
}

/** Marks by name, in the on-disk form of `marks.json`. */
interface MarksFile {
  marks: Record<string, StoredMark>;
}

interface StoredMark {
  epoch_ms: number;
  utc_offset_minutes: number | null;
  processes?: ProcessName[];
}

const MAX_NAME_LENGTH = 64;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * A mark name is a file-name-safe word, and never a duration: `--since` reads both, and
 * `30s` must always mean thirty seconds back.
 */
export function assertMarkName(name: string): void {
  if (name.length > MAX_NAME_LENGTH || !NAME.test(name) || parseDuration(name) !== undefined) {
    throw new AdbAxiError("VALIDATION_ERROR", `"${name}" is not a usable mark name`, {
      help: [
        `Use letters, digits, \`.\`, \`_\` and \`-\` (up to ${MAX_NAME_LENGTH}), and not a duration such as \`30s\``,
      ],
    });
  }
}

/** The marks file of one device, so two devices never see each other's marks (7.2). */
export function marksPath(serial: string, env: NodeJS.ProcessEnv): string {
  return join(deviceStateDir(serial, env), "marks.json");
}

/** Every mark of a device by name; none when the device has never been marked. */
export function readMarks(serial: string, env: NodeJS.ProcessEnv): Map<string, Mark> {
  const path = marksPath(serial, env);
  const value = readJson(path);
  const marks = new Map<string, Mark>();
  if (value === undefined) return marks;
  if (!isMarksFile(value)) throw new Error(`State file ${path} is not a marks file`);
  for (const [name, stored] of Object.entries(value.marks)) {
    marks.set(name, {
      epochMs: stored.epoch_ms,
      utcOffsetMinutes: stored.utc_offset_minutes,
      processes: stored.processes ?? [],
    });
  }
  return marks;
}

/** Store one mark, replacing an earlier mark of the same name. */
export function writeMark(serial: string, env: NodeJS.ProcessEnv, name: string, mark: Mark): void {
  const marks = readMarks(serial, env);
  marks.set(name, mark);
  const file: MarksFile = { marks: {} };
  for (const [markName, value] of marks) {
    file.marks[markName] = {
      epoch_ms: value.epochMs,
      utc_offset_minutes: value.utcOffsetMinutes,
      ...(value.processes.length === 0 ? {} : { processes: value.processes }),
    };
  }
  writeJsonAtomic(marksPath(serial, env), file);
}

/** One mark by name, or `MARK_NOT_FOUND` listing the marks the device does have. */
export function requireMark(serial: string, env: NodeJS.ProcessEnv, name: string): Mark {
  const marks = readMarks(serial, env);
  const mark = marks.get(name);
  if (mark !== undefined) return mark;
  const names = [...marks.keys()];
  throw new AdbAxiError("MARK_NOT_FOUND", `no log mark named ${name} on ${serial}`, {
    fields: { marks: names },
    help: [
      runHint(["logs", "mark", name], "to record it now"),
      ...(names.length === 0
        ? []
        : [`Or pass one of the marks listed above, or a duration such as \`5m\``]),
    ],
  });
}

function isMarksFile(value: unknown): value is MarksFile {
  if (typeof value !== "object" || value === null || !("marks" in value)) return false;
  const marks = value.marks;
  if (typeof marks !== "object" || marks === null) return false;
  return Object.values(marks).every(isStoredMark);
}

function isStoredMark(value: unknown): value is StoredMark {
  if (typeof value !== "object" || value === null) return false;
  const mark = value as Partial<Record<keyof StoredMark, unknown>>;
  return (
    typeof mark.epoch_ms === "number" &&
    (mark.utc_offset_minutes === null || typeof mark.utc_offset_minutes === "number") &&
    (mark.processes === undefined ||
      (Array.isArray(mark.processes) && mark.processes.every(isProcessName)))
  );
}

function isProcessName(value: unknown): value is ProcessName {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<Record<keyof ProcessName, unknown>>;
  return typeof entry.pid === "number" && typeof entry.name === "string";
}

/**
 * The processes worth keeping in a mark: apps, which are named after a dotted package
 * name. System processes (`init`, `[kworker/0:1]`, `/system/bin/...`) are never an app's pids.
 */
export function appProcesses(processes: readonly ProcessName[]): ProcessName[] {
  return processes.filter((process) => {
    const base = process.name.split(":")[0] ?? "";
    return base.includes(".") && isPackageName(base);
  });
}
