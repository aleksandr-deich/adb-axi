import { resolve } from "node:path";
import { exec, type ExecResult } from "../../src/core/exec.js";
import { unrunnableCommands } from "./help-lines.js";

export const ROOT = resolve(import.meta.dirname, "..", "..");
export const BIN_PATH = resolve(ROOT, "dist", "bin", "adb-axi.js");

export interface CliRun {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
}

/** Run the built `adb-axi` bin as an agent would, with the given environment. */
export async function runCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  deadlineMs = 20_000,
): Promise<CliRun> {
  const result: ExecResult = await exec({
    file: process.execPath,
    args: [BIN_PATH, ...args],
    env,
    deadlineMs,
  });
  if (result.kind !== "exited") {
    throw new Error(`adb-axi ${args.join(" ")} did not exit: ${result.kind}`);
  }
  const stdout = result.stdout.toString("utf8");
  // 6.3: every command line any output suggests must run on this build, in every CLI test.
  const unrunnable = unrunnableCommands(stdout);
  if (unrunnable.length > 0) {
    throw new Error(
      `adb-axi ${args.join(" ")} suggested commands this build cannot run: ${unrunnable.join(", ")}`,
    );
  }
  return {
    stdout,
    stderr: result.stderr.toString("utf8"),
    exitCode: result.exitCode,
    durationMs: result.durationMs,
  };
}
