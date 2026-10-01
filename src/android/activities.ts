import type { AdbClient } from "../adb/run.js";
import { parseComponent, type Component } from "./component.js";
import { invalidOutput, readShell, type ReadOptions } from "./read.js";

export const ACTION_MAIN = "android.intent.action.MAIN";
export const CATEGORY_LAUNCHER = "android.intent.category.LAUNCHER";

/**
 * The "Activity Resolver Table" at the top of `dumpsys package <pkg>` (AOSP
 * `IntentResolver.dump`, the same from API 29 to 37). Each filter is printed as
 * `<hash> <package>/<activity> filter <hash>` under the key it is indexed by, then its
 * `Action: "..."` and `Category: "..."` lines indented below it. A filter indexed under
 * several keys is printed once per key, so the same activity can appear many times.
 *
 * The table holds only activities that declare an intent filter: an activity without one
 * can exist and still be missing here.
 */
export function parseActivityFilters(stdout: string): Component[] {
  const filters: Component[] = [];
  let inTable = false;
  for (const line of stdout.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      // A top-level heading ends the previous table.
      inTable = line.trimEnd() === "Activity Resolver Table:";
      continue;
    }
    if (!inTable) continue;
    const entry = /^\s+[0-9a-f]+ (\S+) filter [0-9a-f]+\s*$/.exec(line);
    if (entry?.[1] !== undefined) {
      const component = parseComponent(entry[1]);
      if (component !== null) filters.push(component);
    }
  }
  return filters;
}

export async function resolveLauncherActivity(
  adb: AdbClient,
  serial: string,
  pkg: string,
  userId: number,
  options: ReadOptions,
): Promise<string | null> {
  const step = `resolving the launcher activity of ${pkg}`;
  const result = await readShell(
    adb,
    serial,
    `cmd package query-activities --components --user ${userId} -a ${ACTION_MAIN} -c ${CATEGORY_LAUNCHER} -p ${pkg}`,
    step,
    options,
  );
  const text = result.stdout.trim();
  if (text === "No activities found") return null;
  const component = parseComponent(text.split(/\r?\n/)[0] ?? "");
  if (component?.package !== pkg) throw invalidOutput(step, result.stdout);
  return component.activity;
}

/** The package's activities that the table names, each once, in the order first printed. */
export function declaredActivities(filters: readonly Component[], pkg: string): string[] {
  const names = filters.filter((filter) => filter.package === pkg).map((f) => f.activity);
  return [...new Set(names)];
}
