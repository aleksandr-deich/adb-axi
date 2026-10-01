import { AdbAxiError } from "../core/errors.js";
import { runHint, type Output } from "../core/output.js";
import { capLines, shownLine, writeFullOutput } from "../core/truncate.js";
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
        "The command string, passed after `--` to the device's sh; quoting is up to the caller",
      required: true,
      rest: true,
    },
  ],
  flags: [
    {
      name: "--full",
      type: "boolean",
      description: "Write the complete output to a file instead of stopping at 50 lines or 4 kB",
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

  let result;
  try {
    result = await runShell(context.adb(), target.serial, command, {
      deadline: context.deadline,
      step: `running the command on ${target.serial}`,
    });
  } catch (error) {
    if (error instanceof AdbAxiError && error.code === "TIMEOUT") {
      // The deadline kills the adb client; whatever the command printed until then is kept.
      const partial = streamFields(
        { stdout: text(error.fields.stdout), stderr: text(error.fields.stderr) },
        { serial: target.serial, full },
      );
      throw new AdbAxiError("TIMEOUT", error.message, {
        fields: { step: error.fields.step, ...partial.fields },
        help: [
          ...error.help,
          ...(partial.truncated && !full ? [fullHint(target.serial, command)] : []),
        ],
        cause: error,
      });
    }
    throw error;
  }

  const output = streamFields(result, {
    serial: target.serial,
    full,
    alwaysStdout: result.exitCode === 0,
    alwaysStderr: result.exitCode !== 0,
  });
  const help = output.truncated && !full ? [fullHint(target.serial, command)] : [];
  if (result.exitCode !== 0) {
    throw new AdbAxiError("REMOTE_EXIT", `remote command exited ${result.exitCode}`, {
      fields: { exit: result.exitCode, ...output.fields },
      help,
    });
  }
  return { exit: 0, ...output.fields, ...(help.length > 0 ? { help } : {}) };
}

interface StreamFields {
  fields: Record<string, string>;
  /** Some stream was cut at the caps. */
  truncated: boolean;
}

/**
 * The output fields of one run: a stream with text, plus `stdout` for a success and
 * `stderr` for a failure even when empty. Each is capped at 50 lines or 4 kB with a
 * `shown` note. With `--full` the complete text of every non-empty stream also goes to
 * a file.
 */
function streamFields(
  streams: Record<Stream, string>,
  options: { serial: string; full: boolean; alwaysStdout?: boolean; alwaysStderr?: boolean },
): StreamFields {
  const fields: Record<string, string> = {};
  let truncated = false;
  for (const name of ["stdout", "stderr"] as const) {
    const complete = streams[name];
    const window = capLines(complete);
    const always = name === "stdout" ? options.alwaysStdout : options.alwaysStderr;
    if (complete !== "" || always === true) {
      fields[name] = window.lines.join("\n");
    }
    if (window.truncated) {
      truncated = true;
      fields[key("shown", name)] = shownLine(window);
    }
    if (options.full && complete !== "") {
      fields[key("full", name)] = writeFullOutput(
        `shell-${options.serial}-${clockStamp()}-${name}`,
        complete,
      );
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

function fullHint(serial: string, command: string): string {
  return runHint(
    ["shell", "--device", serial, "--full", "--", command],
    "to write the complete output to a file",
  );
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
