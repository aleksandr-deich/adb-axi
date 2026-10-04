import { refreshMarks } from "../logs/marks.js";
import { readDeviceClock } from "../../android/clock.js";
import type { LogLine } from "../../android/logcat.js";
import { Deadline } from "../../core/deadline.js";
import { AdbAxiError } from "../../core/errors.js";
import { okLine, runHint } from "../../core/output.js";
import { MAX_INTERVAL_MS, poll } from "../../core/poll.js";
import { truncateField } from "../../core/truncate.js";
import { readOptions, targetSerial, UNKNOWN } from "../app/shared.js";
import { defineCommand } from "../define.js";
import {
  clockTime,
  compileRegex,
  readWindowLines,
  resolveWindow,
  windowFromNow,
} from "../logs/window.js";

export const waitLog = defineCommand({
  path: ["wait", "log"],
  summary: "Wait until a log line after the window start matches a regex",
  positionals: [
    { name: "regex", description: "Regex matched against log messages", required: true },
  ],
  flags: [
    {
      name: "--since",
      type: "string",
      valueName: "<mark|dur>",
      description: "Window start: a log mark name, or a duration back from now such as 30s",
      default: "now",
    },
  ],
  examples: [
    "adb-axi wait log 'Displayed com.example.notes' --since before-start",
    "adb-axi wait log 'Room|Migration' --timeout 30s",
  ],
  shipped: true,
  run: async (context) => {
    const source = String(context.positionals.regex);
    const regex = compileRegex("regex", source);
    const since = typeof context.flags.since === "string" ? context.flags.since : undefined;
    const serial = targetSerial(context);
    const options = readOptions(context);
    const adb = context.adb();

    // Without `--since` the window opens now, so only lines logged during the wait count.
    const now = await readDeviceClock(adb, serial, options);
    await refreshMarks(context);
    const window =
      since === undefined
        ? windowFromNow(now)
        : resolveWindow(serial, context.env, since, now, context.marksVerified);

    let latest: Observation | undefined;
    const result = await poll({
      timeoutMs: context.deadline.remainingMs(),
      check: async (remainingMs) => {
        // The last read, at the deadline, still gets a short deadline of its own.
        const reads =
          remainingMs < MAX_INTERVAL_MS ? { deadline: new Deadline(MAX_INTERVAL_MS) } : options;
        let lines: LogLine[];
        try {
          lines = await readWindowLines(adb, serial, window, reads);
        } catch (error) {
          // A read cut off by the deadline ends the wait; the last full observation is the evidence.
          if (error instanceof AdbAxiError && error.code === "TIMEOUT") {
            return { done: false, last: latest };
          }
          throw error;
        }
        // adbd echoes our shell commands, including this poll, into the next dump.
        // Keep those lines in `logs` for diagnostics, but never use them as wait evidence.
        const found = lines.find(
          (line) =>
            !(line.tag === "adbd" && line.message.startsWith("adbd service requested '")) &&
            regex.test(line.message),
        );
        const newest = lines.at(-1);
        latest = {
          lines_scanned: lines.length,
          newest: newest === undefined ? UNKNOWN : describe(newest, now.utcOffsetMinutes),
        };
        return found === undefined ? { done: false, last: latest } : { done: true, value: found };
      },
    });

    if (!result.ok) {
      throw new AdbAxiError(
        "WAIT_TIMEOUT",
        `no log line matching "${source}" within ${formatDuration(context.timeoutMs)}`,
        {
          fields: { last: latest ?? { lines_scanned: UNKNOWN, newest: UNKNOWN } },
          help: [
            runHint(
              ["logs", "--since", since ?? timeoutWindow(context.timeoutMs)],
              "to see what the device logged",
            ),
          ],
        },
      );
    }
    const line = result.value;
    return {
      ok: okLine("wait log", source, `matched after ${result.waitedMs} ms`),
      waited_ms: result.waitedMs,
      match: {
        time: clockTime(line.epochMs, now.utcOffsetMinutes),
        level: line.level,
        tag: line.tag,
        message: truncateField(line.message),
      },
    };
  },
});

/** What one read saw: how many lines the window held and the newest of them. */
interface Observation {
  lines_scanned: number;
  newest: string;
}

function describe(line: LogLine, utcOffsetMinutes: number | null): string {
  return truncateField(
    `${clockTime(line.epochMs, utcOffsetMinutes)} ${line.level} ${line.tag}: ${line.message}`,
    120,
  );
}

export function timeoutWindow(timeoutMs: number): string {
  return `${Math.max(1, Math.ceil((timeoutMs + 1000) / 60_000))}m`;
}

function formatDuration(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`;
}
