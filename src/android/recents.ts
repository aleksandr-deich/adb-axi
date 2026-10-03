import type { AdbClient } from "../adb/run.js";
import { parseActivityRecords, parseComponent } from "./component.js";
import { readShell, type ReadOptions } from "./read.js";

/** One task in `dumpsys activity recents`, most recent first. */
export interface RecentTask {
  /** Position in the recents list; 0 is the most recent. */
  index: number;
  taskId: number;
  userId: number | null;
  /** `standard`, `home`, `recents`, ...; `null` when the dump does not say. */
  type: string | null;
  /** The package of the task's root activity. */
  package: string | null;
  /** The task's root activity as printed (`.MainActivity`), what `app restore` starts. */
  activity: string | null;
  /** `<package>/<activity>` of the root activity. */
  component: string | null;
  /** The activities the task holds now, bottom to top; empty once they are destroyed. */
  activities: string[];
  /** The pid of the task's root process, when it has one. */
  rootPid: number | null;
}

/** `WindowConfiguration.activityTypeToString`, for dumps that print only the number. */
const ACTIVITY_TYPES: readonly string[] = [
  "undefined",
  "standard",
  "home",
  "recents",
  "assistant",
  "dream",
];

/**
 * Parse the "Recent tasks" list (AOSP `RecentTasks.dump` and the task's `dump`). Each task
 * starts with `* Recent #<n>: TaskRecord{<hash> #<id> A=<affinity> ...}` on API 29 and
 * `* Recent #<n>: Task{<hash> #<id> type=<type> A=|I=...}` from API 30. The root activity
 * is `mActivityComponent=` on every release from API 29 to 37. The "Visible recent tasks"
 * section that newer releases add is not part of the list.
 */
export function parseRecents(stdout: string): RecentTask[] {
  const tasks: RecentTask[] = [];
  let current: RecentTask | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    const header = /^ {2}\* Recent #(\d+): (?:Task|TaskRecord)\{[0-9a-f]+ #(\d+)(.*)\}\s*$/.exec(
      line,
    );
    if (header?.[1] !== undefined && header[2] !== undefined) {
      current = {
        index: Number(header[1]),
        taskId: Number(header[2]),
        userId: null,
        type: /\btype=(\w+)/.exec(header[3] ?? "")?.[1] ?? null,
        package: null,
        activity: null,
        component: null,
        activities: [],
        rootPid: null,
      };
      tasks.push(current);
      continue;
    }
    // Task details are indented by four; any shallower line ends the task.
    if (line.trim() === "") continue;
    if (current === undefined || !/^ {4}/.test(line)) {
      current = undefined;
      continue;
    }
    const text = line.trim();
    const user = /\buserId=(\d+)\b/.exec(text);
    if (user?.[1] !== undefined) current.userId = Number(user[1]);
    const root = /^mActivityComponent=(\S+)$/.exec(text);
    if (root?.[1] !== undefined) {
      const component = parseComponent(root[1]);
      if (component !== null) {
        current.package = component.package;
        current.activity = component.activity;
        current.component = component.component;
      }
    }
    const type = /\bactivityType=(\d+)\b/.exec(text);
    if (type?.[1] !== undefined && current.type === null) {
      current.type = ACTIVITY_TYPES[Number(type[1])] ?? null;
    }
    if (text.startsWith("Activities=")) {
      current.activities = parseActivityRecords(text).map((record) => record.component);
    }
    const process = /^mRootProcess=ProcessRecord\{[0-9a-f]+ (\d+):/.exec(text);
    if (process?.[1] !== undefined) current.rootPid = Number(process[1]);
  }
  return tasks;
}

/** The most recent standard task of a package: the one `app restore` brings back. */
export function findTask(
  tasks: readonly RecentTask[],
  pkg: string,
  userId: number,
): RecentTask | undefined {
  return tasks.find(
    (task) =>
      task.package === pkg && task.userId === userId &&
      (task.type === null || task.type === "standard"),
  );
}

export async function readRecents(
  adb: AdbClient,
  serial: string,
  options: ReadOptions,
): Promise<RecentTask[]> {
  const result = await readShell(
    adb,
    serial,
    "dumpsys activity recents",
    "reading recent tasks",
    options,
  );
  return parseRecents(result.stdout);
}
