import type { AdbClient } from "../adb/run.js";
import { parseActivityRecord, type ActivityRecord } from "./component.js";
import { readShell, type ReadOptions } from "./read.js";

/**
 * Where `dumpsys activity activities` names the resumed activity, the first match for
 * the requested user (or any user when unscoped) wins:
 * - `  ResumedActivity: `, the top resumed activity, printed by
 *   `ActivityTaskManagerService.dumpActivitiesLocked` on every release from API 29 to 37
 *   (API 29 also prints a display-level ` ResumedActivity:` with no space before the
 *   record, naming the same activity);
 * - `Resumed: ` under "Resumed activities in task display areas" (API 30);
 * - the per-stack `mResumedActivity: `, top stack first (API 29 and 30);
 * - the per-task `topResumedActivity=` (API 31+).
 */
const RESUMED_LINES: readonly RegExp[] = [
  /^\s*ResumedActivity:\s*(ActivityRecord\{.*)$/m,
  /^\s*Resumed:\s*(ActivityRecord\{.*)$/m,
  /^\s*mResumedActivity:\s*(ActivityRecord\{.*)$/m,
  /^\s*topResumedActivity=(ActivityRecord\{.*)$/m,
];

/**
 * The resumed (foreground) activity. A launcher in front is an answer like any other app.
 * With `userId`, only that user's records count; omitted means unscoped. `null` when
 * no matching activity is resumed, for example while the screen is off.
 */
export function parseForeground(stdout: string, userId?: number): ActivityRecord | null {
  for (const pattern of RESUMED_LINES) {
    for (const match of stdout.matchAll(new RegExp(pattern.source, "gm"))) {
      const record = parseActivityRecord(match[1] ?? "", userId);
      if (record !== null) return record;
    }
  }
  return null;
}

export async function readForeground(
  adb: AdbClient,
  serial: string,
  options: ReadOptions & { userId?: number },
): Promise<ActivityRecord | null> {
  const result = await readShell(
    adb,
    serial,
    "dumpsys activity activities",
    "reading the foreground activity",
    options,
  );
  return parseForeground(result.stdout, options.userId);
}
