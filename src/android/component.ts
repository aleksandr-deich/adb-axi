import { AdbAxiError } from "../core/errors.js";

/** An activity component as `dumpsys` prints it: `dev.probe/.MainActivity`. */
export interface Component {
  package: string;
  /** The class as printed: short (`.MainActivity`) when it is inside the package. */
  activity: string;
  /** `<package>/<activity>`, the form `am start -n` takes. */
  component: string;
}

/**
 * Package names as Android accepts them: dot-separated Java identifiers. A name that is
 * not one never reaches a device shell, where it would be read as shell syntax.
 */
const PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)*$/;

export function isPackageName(name: string): boolean {
  return PACKAGE_NAME.test(name);
}

export function assertPackageName(name: string): void {
  if (!isPackageName(name)) {
    throw new AdbAxiError("VALIDATION_ERROR", `"${name}" is not a valid package name`, {
      help: ["Pass a package name such as `com.example.notes`"],
    });
  }
}

/** Split a flattened component (`ComponentName.flattenToShortString`). */
export function parseComponent(flat: string): Component | null {
  const match = /^([A-Za-z][\w.]*)\/([\w.$]+)$/.exec(flat.trim());
  if (match?.[1] === undefined || match[2] === undefined) return null;
  return { package: match[1], activity: match[2], component: `${match[1]}/${match[2]}` };
}

/** An activity as `ActivityRecord.toString` prints it. */
export interface ActivityRecord extends Component {
  taskId: number;
}

/**
 * `ActivityRecord{<hash> u<user> <package>/<activity> t<task>}`, with ` f` before the brace
 * while finishing (AOSP `ActivityRecord.toString`, the same from API 29 to 37).
 */
const ACTIVITY_RECORD = /ActivityRecord\{[0-9a-f]+ u(\d+) ([^\s/}]+\/[^\s}]+) t(-?\d+)[^}]*\}/g;

export function parseActivityRecord(text: string, userId?: number): ActivityRecord | null {
  return parseActivityRecords(text, userId)[0] ?? null;
}

/** Every activity record in `text`, in the order printed. */
export function parseActivityRecords(text: string, userId?: number): ActivityRecord[] {
  const records: ActivityRecord[] = [];
  for (const match of text.matchAll(ACTIVITY_RECORD)) {
    if (userId !== undefined && Number(match[1]) !== userId) continue;
    const component = parseComponent(match[2] ?? "");
    if (component !== null) records.push({ ...component, taskId: Number(match[3]) });
  }
  return records;
}
