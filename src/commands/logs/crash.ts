import { formatDeviceTime } from "../../android/clock.js";
import { assertPackageName } from "../../android/component.js";
import type { Crash } from "../../android/crash.js";
import { LOG_READ_HELP } from "../../android/logcat.js";
import { FullOutputFile, truncateField } from "../../core/truncate.js";
import { UNKNOWN } from "../app/shared.js";
import { defineCommand } from "../define.js";
import { DEFAULT_SINCE } from "./dump.js";
import { clockTime, openLogWindow, withMarksNote } from "./window.js";

export const logsCrash = defineCommand({
  path: ["logs", "crash"],
  summary: "Java crashes, ANRs and native crashes in one window",
  help: [
    "Counts matching reports and shows the first five summaries; retained-state limits can truncate summary details, reported in a note; --full preserves complete matching traces",
    ...LOG_READ_HELP,
  ],
  flags: [
    {
      name: "--pkg",
      type: "string",
      valueName: "<pkg>",
      description:
        "Only this app's reports (the package or <pkg>:<name>) proven to belong to the current Android user, " +
        "using crash events or tombstone uid; reports without user evidence are omitted and counted. " +
        "No installed package is required. Without --pkg, history spans all users",
    },
    {
      name: "--since",
      type: "string",
      valueName: "<mark|dur>",
      description:
        "Window start: a log mark name, or a duration back from now such as 30s. Crashes before it are not counted",
      default: DEFAULT_SINCE,
    },
    {
      name: "--full",
      type: "boolean",
      description: "Write the whole trace of every crash to a file",
    },
  ],
  examples: [
    "adb-axi logs crash --pkg com.example.notes --since before-save",
    "adb-axi logs crash --since 5m",
  ],
  shipped: true,
  run: async (context) => {
    const pkg = typeof context.flags.pkg === "string" ? context.flags.pkg : undefined;
    if (pkg !== undefined) assertPackageName(pkg);
    const since = typeof context.flags.since === "string" ? context.flags.since : DEFAULT_SINCE;
    const window = await openLogWindow(context.device, since, context.env);
    return withMarksNote(window.marksNote, async () => {
      const { now } = window;
      const full = context.flags.full === true;
      const file = full
        ? new FullOutputFile(
            `crash-${window.label}-${clockTime(now.epochMs, now.utcOffsetMinutes).slice(0, 8).replaceAll(":", "")}`,
          )
        : undefined;
      try {
        const { crashes, count, scanned, unverified, note } = await window.readCrashes(
          pkg,
          file === undefined
            ? undefined
            : {
                file,
                header: (crash) => traceHeader(crash, now.utcOffsetMinutes),
              },
        );

        const seconds = Math.max(0, Math.round((now.epochMs - window.startMs) / 1000));
        const includeCause = crashes.some((crash) => crash.rootCause !== undefined);
        const rows = crashes.map((crash) => describe(crash, now.utcOffsetMinutes, includeCause));
        return {
          crashes: `${count} since ${window.label} (${seconds} s, ${scanned} lines scanned)`,
          ...(note === undefined ? {} : { note }),
          ...(unverified === 0
            ? {}
            : { omitted: `${unverified} matching crash reports without a verified Android user` }),
          // One crash prints as a block, several as a table.
          ...(rows.length === 1 ? { crash: rows[0] } : rows.length > 1 ? { crash: rows } : {}),
          ...(count > crashes.length ? { shown: `${crashes.length} of ${count} crashes` } : {}),
          ...(file === undefined ? {} : { full: file.keep() }),
          ...(crashes.length > 0 && !full
            ? { help: ["Run the same command with `--full` to write the whole trace to a file"] }
            : {}),
        };
      } finally {
        file?.discard();
      }
    });
  },
});

/** One crash as the output states it. */
function describe(
  crash: Crash,
  utcOffsetMinutes: number | null,
  includeCause: boolean,
): Record<string, unknown> {
  return {
    kind: crash.kind,
    at: formatDeviceTime(crash.epochMs, utcOffsetMinutes),
    process: crash.process,
    exception: crash.exception,
    message: truncateField(crash.message),
    ...(includeCause
      ? {
          cause: truncateField(crash.rootCause?.exception ?? UNKNOWN),
          cause_message: truncateField(crash.rootCause?.message ?? UNKNOWN),
        }
      : {}),
    app_frame: crash.appFrame ?? UNKNOWN,
    frames: crash.frames,
  };
}

function traceHeader(crash: Crash, utcOffsetMinutes: number | null): string {
  const pid = crash.pid === null ? "" : ` (pid ${crash.pid})`;
  return `== ${crash.kind} at ${formatDeviceTime(crash.epochMs, utcOffsetMinutes)} in ${crash.process}${pid}`;
}
