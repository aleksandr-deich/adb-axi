import { join } from "node:path";
import { readShellFacts, type DeviceFacts } from "../../device/facts.js";
import type { CommandContext } from "../types.js";
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
  /**
   * The host's clock when the mark was taken, so its age can be told even when the device
   * clock is off. Absent for marks taken before it was recorded.
   */
  hostEpochMs?: number;
}

/** Marks by name, in the on-disk form of `marks.json`. */
interface MarksFile {
  boot_id?: string;
  marks: Record<string, StoredMark>;
}

interface StoredMark {
  epoch_ms: number;
  utc_offset_minutes: number | null;
  processes?: ProcessName[];
  host_epoch_ms?: number;
}

const MAX_NAME_LENGTH = 64;
const NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

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

/**
 * Refresh the boot identity before any mark is stored or used, after validating input.
 * Returns the facts it read, or `undefined` when the device did not answer, so the command
 * never reads them twice.
 */
export async function refreshMarks(context: CommandContext): Promise<DeviceFacts | undefined> {
  const target = context.target;
  if (target === undefined) throw new Error("Marks need a resolved device");
  let facts: DeviceFacts | undefined;
  try {
    facts = await readShellFacts(context.adb(), target.device, {
      deadline: context.deadline,
      env: context.env,
    });
  } catch (error) {
    if (!(error instanceof AdbAxiError)) throw error;
  }
  bindTargetMarks(context, facts?.bootId ?? null);
  return facts;
}

/** Bind the target's marks to the boot ID this command read, `null` when it could not. */
export function bindTargetMarks(context: CommandContext, bootId: string | null): void {
  const target = context.target;
  if (target === undefined) throw new Error("Marks need a resolved device");
  context.marksVerified = bootId !== null;
  const note = bindMarks(target.serial, context.env, bootId);
  if (note !== undefined) context.marksNote = note;
}

/** Bind the serial's marks to the current boot, dropping unbound legacy marks too. */
export function bindMarks(
  serial: string,
  env: NodeJS.ProcessEnv,
  bootId: string | null,
): string | undefined {
  const path = marksPath(serial, env);
  const value = readJson(path);
  if (value !== undefined && !isMarksFile(value))
    throw new Error(`State file ${path} is not a marks file`);
  if (bootId === null) {
    return value !== undefined && Object.keys(value.marks).length > 0
      ? "Log marks could not be verified for this boot; stored marks were not used"
      : undefined;
  }
  if (value?.boot_id === bootId) return undefined;
  const dropped = value !== undefined && Object.keys(value.marks).length > 0;
  writeJsonAtomic(path, { boot_id: bootId, marks: {} } satisfies MarksFile);
  return dropped ? "Log marks from a previous device or boot were dropped" : undefined;
}

/** A named window or a new mark requires proof of the device's current boot. */
export function assertMarkVerified(serial: string, name: string, verified: boolean): void {
  if (verified) return;
  throw new AdbAxiError(
    "MARK_UNVERIFIED",
    `log mark ${name} could not be verified for this boot on ${serial}`,
    {
      help: [
        runHint(["logs", "mark", name], "to re-mark once the device's boot ID can be read"),
        "Or use a duration such as `--since 5m` instead of a stored mark",
      ],
    },
  );
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
      ...(stored.host_epoch_ms === undefined ? {} : { hostEpochMs: stored.host_epoch_ms }),
    });
  }
  return marks;
}

/** Store one mark, replacing an earlier mark of the same name. */
export function writeMark(serial: string, env: NodeJS.ProcessEnv, name: string, mark: Mark): void {
  const marks = readMarks(serial, env);
  marks.set(name, mark);
  const stored = readJson(marksPath(serial, env));
  const bootId = isMarksFile(stored) ? stored.boot_id : undefined;
  const file: MarksFile = {
    ...(bootId === undefined ? {} : { boot_id: bootId }),
    marks: Object.create(null) as Record<string, StoredMark>,
  };
  for (const [markName, value] of marks) {
    file.marks[markName] = {
      epoch_ms: value.epochMs,
      utc_offset_minutes: value.utcOffsetMinutes,
      ...(value.processes.length === 0 ? {} : { processes: value.processes }),
      ...(value.hostEpochMs === undefined ? {} : { host_epoch_ms: value.hostEpochMs }),
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
  // `3potatoes` or `1h` was meant as a duration, not as a mark to record under that name.
  const durationLike = DURATION_LIKE.test(name);
  throw new AdbAxiError("MARK_NOT_FOUND", `no log mark named ${name} on ${serial}`, {
    fields: { marks: names },
    help: [
      ...(durationLike
        ? [
            `\`${name}\` is not a duration either: use a whole number with ms, s or m, for example \`--since 30s\` or \`--since 5m\``,
          ]
        : [runHint(["logs", "mark", name], "to record it now")]),
      ...(names.length === 0
        ? []
        : [`Or pass one of the marks listed above, or a duration such as \`5m\``]),
    ],
  });
}

/** A value that starts like a duration: a number, then perhaps a unit. */
const DURATION_LIKE = /^\d+(?:\.\d+)?\s*[A-Za-z]*$/;

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
      (Array.isArray(mark.processes) && mark.processes.every(isProcessName))) &&
    (mark.host_epoch_ms === undefined || typeof mark.host_epoch_ms === "number")
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
