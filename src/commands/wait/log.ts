import type { LogLine } from "../../android/logcat.js";
import { formatDuration } from "../../core/duration.js";
import { AdbAxiError } from "../../core/errors.js";
import { okLine, runHint } from "../../core/output.js";
import { observe } from "../../core/poll.js";
import { truncateField } from "../../core/truncate.js";
import { UNKNOWN } from "../app/shared.js";
import { defineCommand } from "../define.js";
import { clockTime, compileRegex, openLogWindow, withMarksNote } from "../logs/window.js";

export const waitLog = defineCommand({
  path: ["wait", "log"],
  help: ["adbd service-request echoes of shell commands do not count as log matches"],
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
    const window = await openLogWindow(context.device, since, context.env);
    return withMarksNote(window.marksNote, async () => {
      const { now } = window;
      const result = await observe({
        deadline: context.deadline,
        read: async (deadline) => {
          const lines = await window.readLines({ ...context.device.reads, deadline });
          // adbd echoes our shell commands, including this poll, into the next dump.
          // Keep those lines in `logs` for diagnostics, but never use them as wait evidence.
          const found = lines.find(
            (line) =>
              !(line.tag === "adbd" && line.message.startsWith("adbd service requested '")) &&
              regex.test(line.message),
          );
          const newest = lines.at(-1);
          return {
            summary: {
              lines_scanned: lines.length,
              newest: newest === undefined ? UNKNOWN : describe(newest, now.utcOffsetMinutes),
            },
            found,
          };
        },
        done: (latest): latest is typeof latest & { found: LogLine } => latest.found !== undefined,
      });

      if (!result.ok) {
        throw new AdbAxiError(
          "WAIT_TIMEOUT",
          `no log line matching "${source}" within ${formatDuration(context.timeoutMs)}`,
          {
            fields: { last: result.last?.summary ?? { lines_scanned: UNKNOWN, newest: UNKNOWN } },
            help: [
              runHint(
                ["logs", "--since", since ?? timeoutWindow(context.timeoutMs)],
                "to see what the device logged",
              ),
            ],
          },
        );
      }
      const line = result.value.found;
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
    });
  },
});

function describe(line: LogLine, utcOffsetMinutes: number | null): string {
  return truncateField(
    `${clockTime(line.epochMs, utcOffsetMinutes)} ${line.level} ${line.tag}: ${line.message}`,
    120,
  );
}

export function timeoutWindow(timeoutMs: number): string {
  return `${Math.max(1, Math.ceil((timeoutMs + 1000) / 60_000))}m`;
}
