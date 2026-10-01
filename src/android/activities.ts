import { parseComponent, type Component } from "./component.js";

/** One intent filter of an activity, as the activity resolver table prints it. */
export interface ActivityFilter extends Component {
  actions: string[];
  categories: string[];
}

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
export function parseActivityFilters(stdout: string): ActivityFilter[] {
  const filters: ActivityFilter[] = [];
  let inTable = false;
  let current: ActivityFilter | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      // A top-level heading ends the previous table.
      inTable = line.trimEnd() === "Activity Resolver Table:";
      current = undefined;
      continue;
    }
    if (!inTable) continue;
    const entry = /^\s+[0-9a-f]+ (\S+) filter [0-9a-f]+\s*$/.exec(line);
    if (entry?.[1] !== undefined) {
      const component = parseComponent(entry[1]);
      current = component === null ? undefined : { ...component, actions: [], categories: [] };
      if (current !== undefined) filters.push(current);
      continue;
    }
    if (current === undefined) continue;
    const action = /^\s+Action: "([^"]+)"/.exec(line);
    if (action?.[1] !== undefined) current.actions.push(action[1]);
    const category = /^\s+Category: "([^"]+)"/.exec(line);
    if (category?.[1] !== undefined) current.categories.push(category[1]);
  }
  return filters;
}

/**
 * The activity a launcher starts: the first of the package's filters with the MAIN action
 * and the LAUNCHER category. `null` when the package has none.
 */
export function launcherActivity(filters: readonly ActivityFilter[], pkg: string): string | null {
  const launcher = filters.find(
    (filter) =>
      filter.package === pkg &&
      filter.actions.includes(ACTION_MAIN) &&
      filter.categories.includes(CATEGORY_LAUNCHER),
  );
  return launcher?.activity ?? null;
}

/** The package's activities that the table names, each once, in the order first printed. */
export function declaredActivities(filters: readonly ActivityFilter[], pkg: string): string[] {
  const names = filters.filter((filter) => filter.package === pkg).map((f) => f.activity);
  return [...new Set(names)];
}
