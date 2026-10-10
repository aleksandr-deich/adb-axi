import { refreshMarks } from "./marks.js";
import { readDeviceClock, formatDeviceTime } from "../../android/clock.js";
import { assertPackageName } from "../../android/component.js";
import { crashBelongsTo, parseCrashes, type Crash } from "../../android/crash.js";
import { truncateField, writeFullOutput } from "../../core/truncate.js";
import { UNKNOWN, readOptions, targetSerial } from "../app/shared.js";
import { defineCommand } from "../define.js";
import { DEFAULT_SINCE } from "./dump.js";
import { clockTime, readWindowLines, resolveWindow } from "./window.js";

/** How many crashes one answer describes; a crash loop prints its first few and counts the rest. */
const MAX_CRASHES = 5;

export const logsCrash = defineCommand({
  path: ["logs", "crash"],
  summary: "Java crashes, ANRs and native crashes in one window, matched by package name",
  flags: [
    {
      name: "--pkg",
      type: "string",
      valueName: "<pkg>",
      description:
        "Only this app, by the process name in the crash report (the package or <pkg>:<name>), " +
        "never by uid or pid; a package that is not installed, or that never crashed, counts 0",
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
    const serial = targetSerial(context);
    const options = readOptions(context);
    const adb = context.adb();

    const now = await readDeviceClock(adb, serial, options);
    await refreshMarks(context);
    const window = resolveWindow(serial, context.env, since, now, context.marksVerified);
    // The scan is never narrowed to the app: its ANR is printed by system_server and its
    // tombstone by crash_dump, which a uid or pid filter would drop.
    const lines = await readWindowLines(adb, serial, window, options, undefined, true);
    const crashes = parseCrashes(lines).filter(
      (crash) =>
        crash.epochMs >= window.startMs && (pkg === undefined || crashBelongsTo(crash, pkg)),
    );
    const scanned = lines.filter((line) => line.epochMs >= window.startMs);

    const seconds = Math.max(0, Math.round((now.epochMs - window.startMs) / 1000));
    const full = context.flags.full === true;
    const shown = crashes.slice(0, MAX_CRASHES);
    const includeCause = shown.some((crash) => crash.rootCause !== undefined);
    const rows = shown.map((crash) => describe(crash, now.utcOffsetMinutes, includeCause));
    return {
      crashes: `${crashes.length} since ${window.label} (${seconds} s, ${scanned.length} lines scanned)`,
      // One crash prints as a block, several as a table.
      ...(rows.length === 1 ? { crash: rows[0] } : rows.length > 1 ? { crash: rows } : {}),
      ...(crashes.length > shown.length
        ? { shown: `${shown.length} of ${crashes.length} crashes` }
        : {}),
      ...(full
        ? {
            full: writeFullOutput(
              `crash-${window.label}-${clockTime(now.epochMs, now.utcOffsetMinutes).slice(0, 8).replaceAll(":", "")}`,
              crashes.map((crash) => traceText(crash, now.utcOffsetMinutes)).join(""),
            ),
          }
        : {}),
      ...(crashes.length > 0 && !full
        ? { help: ["Run the same command with `--full` to write the whole trace to a file"] }
        : {}),
    };
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

/** One crash for the `--full` file: a header line, then every line of its block. */
function traceText(crash: Crash, utcOffsetMinutes: number | null): string {
  const pid = crash.pid === null ? "" : ` (pid ${crash.pid})`;
  const header = `== ${crash.kind} at ${formatDeviceTime(crash.epochMs, utcOffsetMinutes)} in ${crash.process}${pid}`;
  return `${[header, ...crash.trace].join("\n")}\n\n`;
}
