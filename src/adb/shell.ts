import type { AdbCallOptions, AdbClient } from "./run.js";

export interface ShellResult {
  stdout: string;
  stderr: string;
  /** The remote command's own exit code. */
  exitCode: number;
  durationMs: number;
}

/**
 * Run one command string through the device's `sh`. adb uses the shell_v2 protocol for
 * every device adb-axi supports (it needs API 24; adb-axi's floor is 29), which keeps
 * stdout and stderr apart and returns the remote exit code as adb's own (S2). adb-axi
 * never passes `-x`, which would fall back to the legacy protocol that always exits 0.
 *
 * On a deadline, the TIMEOUT error keeps the partial output.
 */
export async function runShell(
  adb: AdbClient,
  serial: string,
  command: string,
  options: AdbCallOptions,
): Promise<ShellResult> {
  const result = await adb.device(serial, ["shell", command], {
    keepPartialOutput: true,
    ...options,
    remoteOutput: true,
  });
  return {
    stdout: result.stdout.toString("utf8"),
    stderr: result.stderr.toString("utf8"),
    exitCode: result.exitCode,
    durationMs: result.durationMs,
  };
}
