import { formatDuration } from "../core/duration.js";
import { AdbAxiError } from "../core/errors.js";
import { DEFAULT_MAX_OUTPUT_BYTES } from "../core/exec.js";
import { runHint, TextBlock, type Output } from "../core/output.js";
import {
  capEnds,
  capLines,
  FullOutputFile,
  MAX_BYTES,
  shownLine,
  splitLines,
  windowRows,
  withGap,
  type LineWindow,
} from "../core/truncate.js";
import { runShell } from "../adb/shell.js";
import { defineCommand } from "./define.js";
import type { DeviceContext } from "./types.js";

export const shell = defineCommand({
  path: ["shell"],
  summary: "Run one command string in the device shell and report its real exit code",
  shipped: true,
  positionals: [
    {
      name: "cmd",
      description:
        "The command string, passed after `--` to the device's sh; quoting is up to the caller. Flags such as --device go before `--`: everything after it runs on the device",
      required: true,
      rest: true,
    },
  ],
  flags: [
    {
      name: "--full",
      type: "boolean",
      description: `Write the complete output to a file, however large, and show its last 50 lines or 4 kB instead of its first and last lines; without it a command that prints over ${DEFAULT_MAX_OUTPUT_BYTES / 1024 / 1024} MiB is stopped`,
    },
  ],
  examples: [
    "adb-axi shell -- 'getprop ro.build.version.sdk'",
    "adb-axi shell --device emulator-5556 -- 'ls /data/local/tmp'",
  ],
  help: ["Use --json to parse stdout and check exit (the remote command's exit code)"],
  run: runShellCommand,
});

type Stream = "stdout" | "stderr";

async function runShellCommand(context: DeviceContext): Promise<Output> {
  const target = context.device.target;
  const raw = context.positionals.cmd;
  const command = Array.isArray(raw) ? raw.join(" ") : (raw ?? "");
  const full = context.flags.full === true;
  const timeout = context.flags.timeout;
  const hint = fullHint(target.serial, command, typeof timeout === "number" ? timeout : undefined);

  // With --full each stream goes to its file as it arrives, so its size is not bounded by
  // what adb-axi keeps in memory; without it, a command that prints too much is stopped.
  const spools = full
    ? { stdout: new Spool(target.serial, "stdout"), stderr: new Spool(target.serial, "stderr") }
    : undefined;
  try {
    let result;
    try {
      result = await runShell(context.device.adb, target.serial, command, {
        deadline: context.deadline,
        step: "running the command",
        ...(spools === undefined
          ? {
              limitHelp: [
                "Redirect the output to a file on the device, for example `> /data/local/tmp/out.txt`, and read only the part you need",
                hint,
              ],
            }
          : {
              // The spools keep the output; adb's own failure text is short.
              maxOutputBytes: SPOOL_MEMORY_BYTES,
              sink: (stream: Stream, chunk: Buffer) => {
                spools[stream].add(chunk);
              },
            }),
      });
    } catch (error) {
      if (error instanceof AdbAxiError && error.code === "TIMEOUT") {
        // The deadline kills the adb client; whatever the command printed until then is kept.
        const partial = streamFields(
          { stdout: text(error.fields.stdout), stderr: text(error.fields.stderr) },
          { serial: target.serial, spools },
        );
        throw new AdbAxiError("TIMEOUT", error.message, {
          fields: { step: error.fields.step, ...partial.fields },
          help: [...error.help, ...(partial.truncated && !full ? [hint] : [])],
          cause: error,
        });
      }
      throw error;
    }

    const output = streamFields(result, {
      serial: target.serial,
      spools,
      alwaysStdout: result.exitCode === 0,
      alwaysStderr: result.exitCode !== 0,
    });
    const help = output.truncated && !full ? [hint] : [];
    if (result.exitCode !== 0) {
      throw new AdbAxiError("REMOTE_EXIT", `remote command exited ${result.exitCode}`, {
        fields: { exit: result.exitCode, ...output.fields },
        help,
      });
    }
    return { exit: 0, ...output.fields, ...(help.length > 0 ? { help } : {}) };
  } finally {
    spools?.stdout.file.discard();
    spools?.stderr.file.discard();
  }
}

/** What `--full` keeps of each stream in memory, besides its file: enough for adb's own errors. */
const SPOOL_MEMORY_BYTES = 16 * MAX_BYTES;
/** How much of the end of a `--full` file is read back for its window: plenty for 4 kB. */
const SPOOL_TAIL_BYTES = 16 * MAX_BYTES;

/**
 * One stream with `--full`: written to its file as it arrives, with its lines counted and
 * the place of its last line break kept, so its window can be read back from the file's end.
 */
class Spool {
  readonly file: FullOutputFile;
  private bytes = 0;
  private breaks = 0;
  private last: number | undefined;
  /** Offsets of the last two line breaks. */
  private lastBreak: number | undefined;
  private breakBefore: number | undefined;

  constructor(serial: string, stream: Stream) {
    this.file = new FullOutputFile(`shell-${serial}-${clockStamp()}-${stream}`);
  }

  add(chunk: Buffer): void {
    this.file.write(chunk);
    for (let at = chunk.indexOf(0x0a); at !== -1; at = chunk.indexOf(0x0a, at + 1)) {
      this.breakBefore = this.lastBreak;
      this.lastBreak = this.bytes + at;
      this.breaks++;
    }
    this.bytes += chunk.length;
    this.last = chunk.at(-1) ?? this.last;
  }

  get empty(): boolean {
    return this.bytes === 0;
  }

  /** The stream's last 50 lines or 4 kB, with the lines before them as a gap. */
  window(): LineWindow {
    const total = this.breaks + (this.last === undefined || this.last === 0x0a ? 0 : 1);
    if (total === 0) return { lines: [], total: 0, truncated: false };
    const endsInBreak = this.last === 0x0a;
    const lastStart = (endsInBreak ? this.breakBefore : this.lastBreak) ?? -1;
    const start = Math.max(0, this.bytes - SPOOL_TAIL_BYTES);
    let window: LineWindow;
    if (lastStart + 1 < start) {
      // The last line alone is longer than what is read back: read its start, to be cut.
      const end = endsInBreak ? (this.lastBreak ?? this.bytes) : this.bytes;
      const line = this.read(lastStart + 1, Math.min(end, lastStart + 1 + SPOOL_TAIL_BYTES));
      const shown = capLines(splitLines(line.toString("utf8")).slice(0, 1));
      const crlf = endsInBreak && this.read(end - 1, end)[0] === 0x0d ? 1 : 0;
      const totalBytes = end - crlf - lastStart - 1;
      const shownBytes = Buffer.byteLength(shown.lines[0] ?? "", "utf8");
      window = { lines: shown.lines, total: 1, truncated: true, cut: { shownBytes, totalBytes } };
    } else {
      // Read from just before the first whole line: the partial line before it is dropped.
      const from = Math.max(0, start - 1);
      let text = this.read(from, this.bytes).toString("utf8");
      if (from > 0) text = text.slice(text.indexOf("\n") + 1);
      window = capLines(text, { keep: "tail" });
    }
    return withGap({ ...window, total }, 0);
  }

  private read(from: number, to: number): Buffer {
    return this.file.readAt(from, to - from);
  }
}

interface StreamFields {
  /** `stdout` and `stderr` are text blocks, so TOON prints their lines one per row. */
  fields: Record<string, string | TextBlock>;
  /** Some stream was cut at the caps. */
  truncated: boolean;
}

/**
 * The output fields of one run: a stream with text, plus `stdout` for a success and
 * `stderr` for a failure even when empty. Each is capped at 50 lines or 4 kB with a
 * `shown` note: its first and last lines, since a command's result is often at its end,
 * with a row that says how many lines are left out between them. With `--full` the
 * complete text of every non-empty stream is kept in a file, and the window shows its
 * end, the part the first window left out.
 */
function streamFields(
  streams: Record<Stream, string>,
  options: {
    serial: string;
    spools: Record<Stream, Spool> | undefined;
    alwaysStdout?: boolean;
    alwaysStderr?: boolean;
  },
): StreamFields {
  const fields: Record<string, string | TextBlock> = {};
  let truncated = false;
  for (const name of ["stdout", "stderr"] as const) {
    const spool = options.spools?.[name];
    const empty = spool === undefined ? streams[name] === "" : spool.empty;
    const window = spool === undefined ? capEnds(streams[name]) : spool.window();
    const always = name === "stdout" ? options.alwaysStdout : options.alwaysStderr;
    if (!empty || always === true) {
      fields[name] = new TextBlock(windowRows(window).join("\n"));
    }
    if (window.truncated) {
      truncated = true;
      fields[key("shown", name)] = shownLine(window);
    }
    if (spool !== undefined && !empty) {
      fields[key("full", name)] = spool.file.keep();
    }
  }
  return { fields, truncated };
}

/** Local time as `HHMMSS`, to tell `--full` files apart. */
function clockStamp(): string {
  const now = new Date();
  return [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join("");
}

/** `shown` and `full` describe stdout; stderr's get a prefix. */
function key(base: string, stream: Stream): string {
  return stream === "stdout" ? base : `stderr_${base}`;
}

function fullHint(serial: string, command: string, timeoutMs: number | undefined): string {
  const timeout =
    timeoutMs === undefined ? [] : ["--timeout", formatDuration(timeoutMs, "argument")];
  return runHint(
    ["shell", "--device", serial, ...timeout, "--full", "--", command],
    "to write the complete output to a file",
  );
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
