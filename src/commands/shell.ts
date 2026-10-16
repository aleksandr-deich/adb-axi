import { formatDuration } from "../core/args.js";
import { AdbAxiError } from "../core/errors.js";
import { DEFAULT_MAX_OUTPUT_BYTES } from "../core/exec.js";
import { runHint, TextBlock, type Output } from "../core/output.js";
import {
  capLines,
  FullOutputFile,
  MAX_BYTES,
  shownLine,
  type LineWindow,
} from "../core/truncate.js";
import { runShell } from "../adb/shell.js";
import { defineCommand } from "./define.js";
import type { CommandContext } from "./types.js";

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
      description: `Write the complete output to a file, however large, instead of stopping at 50 lines or 4 kB; without it a command that prints over ${DEFAULT_MAX_OUTPUT_BYTES / 1024 / 1024} MiB is stopped`,
    },
  ],
  examples: [
    "adb-axi shell -- 'getprop ro.build.version.sdk'",
    "adb-axi shell --device emulator-5556 -- 'ls /data/local/tmp'",
  ],
  run: runShellCommand,
});

type Stream = "stdout" | "stderr";

async function runShellCommand(context: CommandContext): Promise<Output> {
  const target = context.target;
  if (target === undefined) throw new Error("shell was dispatched without a resolved device");
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
      result = await runShell(context.adb(), target.serial, command, {
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
              // The spools keep what the window needs; adb's own failure text is short.
              maxOutputBytes: SPOOL_HEAD_BYTES,
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

/** What `--full` keeps of one stream for the screen: enough for the 50-line, 4 kB window. */
const SPOOL_HEAD_BYTES = 16 * MAX_BYTES;

/**
 * One stream with `--full`: written to its file as it arrives, with its lines counted and
 * only its first bytes kept, so the window and its `shown` note need no more.
 */
class Spool {
  readonly file: FullOutputFile;
  private readonly head: Buffer[] = [];
  private headBytes = 0;
  private bytes = 0;
  private breaks = 0;
  private last: number | undefined;
  /** Bytes of the first line once its end is seen, as `capLines` counts them. */
  private firstLineBytes: number | undefined;

  constructor(serial: string, stream: Stream) {
    this.file = new FullOutputFile(`shell-${serial}-${clockStamp()}-${stream}`);
  }

  add(chunk: Buffer): void {
    this.file.write(chunk);
    if (this.headBytes < SPOOL_HEAD_BYTES) {
      const part = chunk.subarray(0, SPOOL_HEAD_BYTES - this.headBytes);
      this.head.push(part);
      this.headBytes += part.length;
    }
    for (let at = chunk.indexOf(0x0a); at !== -1; at = chunk.indexOf(0x0a, at + 1)) {
      if (this.firstLineBytes === undefined) {
        const before = at > 0 ? chunk[at - 1] : this.last;
        this.firstLineBytes = this.bytes + at - (before === 0x0d ? 1 : 0);
      }
      this.breaks++;
    }
    this.bytes += chunk.length;
    this.last = chunk.at(-1) ?? this.last;
  }

  get empty(): boolean {
    return this.bytes === 0;
  }

  /** The window `capLines` gives for the whole stream. */
  window(): LineWindow {
    const head = capLines(Buffer.concat(this.head).toString("utf8"));
    const total = this.breaks + (this.last === undefined || this.last === 0x0a ? 0 : 1);
    const cut =
      head.cut === undefined
        ? undefined
        : { shownBytes: head.cut.shownBytes, totalBytes: this.firstLineBytes ?? this.bytes };
    const window: LineWindow = {
      lines: head.lines,
      total,
      truncated: cut !== undefined || head.lines.length < total,
    };
    return cut === undefined ? window : { ...window, cut };
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
 * `shown` note. With `--full` the complete text of every non-empty stream is kept in a
 * file, and the window comes from its spool.
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
    const window = spool === undefined ? capLines(streams[name]) : spool.window();
    const always = name === "stdout" ? options.alwaysStdout : options.alwaysStderr;
    if (!empty || always === true) {
      fields[name] = new TextBlock(window.lines.join("\n"));
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
  const timeout = timeoutMs === undefined ? [] : ["--timeout", formatDuration(timeoutMs)];
  return runHint(
    ["shell", "--device", serial, ...timeout, "--full", "--", command],
    "to write the complete output to a file",
  );
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
