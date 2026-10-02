import type { AdbClient } from "../adb/run.js";
import { readShell, type ReadOptions } from "./read.js";

/**
 * A process or instrumentation on the device that may own the single UiAutomation
 * connection. The probe finds instrumentations; `doctor ui` adds the other kinds.
 */
export interface Holder {
  kind: "instrumentation";
  /** The package of the instrumentation's runner, for example `com.example.notes.test`. */
  package: string;
  /** The runner component, `<package>/<class>`. */
  component: string;
  /** Whether the instrumentation was started with a UiAutomation connection (`am instrument` does). */
  uiAutomation: boolean;
}

const HEADER =
  /^\s*Instrumentation #\d+: ActiveInstrumentation\{\S+ \{([^/\s}]+)\/([^\s}]+)\}( FINISHED)? \d+ procs\}\s*$/;

/**
 * The live instrumentations in `dumpsys activity processes`. The section is printed by
 * `ActivityManagerService.dumpActiveInstruments` (AOSP, API 29 to 37): a header line per
 * instrumentation, then its fields; `mUiAutomationConnection=` is printed only when the
 * instrumentation was given a UiAutomation connection. Finished ones are not holders.
 */
export function parseInstrumentations(dump: string): Holder[] {
  const holders: Holder[] = [];
  let current: { holder: Holder; finished: boolean } | undefined;
  let inSection = false;
  const close = (): void => {
    if (current && !current.finished) holders.push(current.holder);
    current = undefined;
  };
  for (const line of dump.split(/\r?\n/)) {
    if (/^ {2}Active instrumentation:\s*$/.test(line)) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    const header = HEADER.exec(line);
    if (header?.[1] !== undefined && header[2] !== undefined) {
      close();
      current = {
        holder: {
          kind: "instrumentation",
          package: header[1],
          component: `${header[1]}/${header[2]}`,
          uiAutomation: false,
        },
        finished: header[3] !== undefined,
      };
      continue;
    }
    if (current && /^\s+mUiAutomationConnection=/.test(line)) {
      current.holder.uiAutomation = true;
    }
    // The section ends at the next two-space-indented heading (`OOM levels:` and so on).
    if (/^ {2}\S/.test(line)) {
      close();
      inSection = false;
    }
  }
  close();
  return holders;
}

/** Everything on the device that may hold UiAutomation right now. */
export async function probeHolders(
  adb: AdbClient,
  serial: string,
  options: ReadOptions,
): Promise<Holder[]> {
  const result = await readShell(
    adb,
    serial,
    "dumpsys activity processes",
    "looking for running instrumentations",
    options,
  );
  return parseInstrumentations(result.stdout);
}
