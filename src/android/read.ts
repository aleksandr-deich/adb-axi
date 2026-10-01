import type { AdbClient } from "../adb/run.js";
import { runShell, type ShellResult } from "../adb/shell.js";
import type { Deadline } from "../core/deadline.js";
import { AdbAxiError } from "../core/errors.js";

/** What every device read takes: the command's one deadline, and an optional tighter cap. */
export interface ReadOptions {
  deadline: Deadline;
  capMs?: number;
}

/**
 * Run one read-only shell command on the device. Exit codes outside `okExits` are failures
 * (`REMOTE_EXIT` with the exit code and stderr), never output to parse: a failed read
 * must not pass for "nothing found".
 */
export async function readShell(
  adb: AdbClient,
  serial: string,
  command: string,
  step: string,
  options: ReadOptions,
  okExits: readonly number[] = [0],
): Promise<ShellResult> {
  const result = await runShell(adb, serial, command, {
    deadline: options.deadline,
    step,
    ...(options.capMs === undefined ? {} : { capMs: options.capMs }),
  });
  if (!okExits.includes(result.exitCode)) {
    throw new AdbAxiError(
      "REMOTE_EXIT",
      `${step} failed: \`${command}\` exited ${result.exitCode}`,
      {
        fields: { step, exit: result.exitCode, stderr: result.stderr.trim() },
      },
    );
  }
  return result;
}

/** Device output a parser cannot read: never guessed at, always reported. */
export function invalidOutput(step: string, output: string): AdbAxiError {
  return new AdbAxiError("INVALID_OUTPUT", `${step} printed output adb-axi cannot read`, {
    fields: { step, detail: output.trim().slice(0, 200) },
  });
}
