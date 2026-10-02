import type { Deadline } from "../core/deadline.js";
import { AdbAxiError } from "../core/errors.js";
import { exec } from "../core/exec.js";
import { shellWords } from "../core/output.js";
import { adbFailureError, classifyAdbFailure, classifyShellFailure } from "./variants.js";

export interface AdbCallOptions {
  deadline: Deadline;
  /** What this call is doing, named in `TIMEOUT` errors, for example "reading device facts". */
  step: string;
  /** A tighter cap for this one call, below what is left of the command deadline. */
  capMs?: number;
  input?: string | Uint8Array;
  maxOutputBytes?: number;
  /** On timeout, keep the partial stdout and stderr in the error's fields. */
  keepPartialOutput?: boolean;
  /**
   * The output is a remote command's: only an exit 1 with empty stdout and one of adb's own
   * prefixed stderr lines is classified as adb's failure.
   */
  remoteOutput?: boolean;
}

export interface AdbExit {
  stdout: Buffer;
  stderr: Buffer;
  /** The adb client's exit code; a signal death is reported as 128 + signal number. */
  exitCode: number;
  durationMs: number;
}

export interface AdbClientOptions {
  /** Print every adb argv (and its outcome) on stderr. */
  debug?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Where debug lines go; defaults to process.stderr. */
  log?: (line: string) => void;
}

/**
 * The only way adb-axi runs adb. Every call is an argument array (never a host shell
 * string), carries a deadline and is killed when it passes it, and every device call is
 * `adb -s <serial> ...`, so adb's own default device is never relied on (7.2).
 */
export class AdbClient {
  readonly path: string;
  private readonly options: AdbClientOptions;

  constructor(path: string, options: AdbClientOptions = {}) {
    this.path = path;
    this.options = options;
  }

  /** A host-side call that targets no device, such as `devices -l`. */
  host(args: readonly string[], options: AdbCallOptions): Promise<AdbExit> {
    return this.call([...args], undefined, options);
  }

  /** A call on one device: always `adb -s <serial> <args>`. */
  device(serial: string, args: readonly string[], options: AdbCallOptions): Promise<AdbExit> {
    if (serial === "") throw new TypeError("A device call needs a serial");
    return this.call(["-s", serial, ...args], serial, options);
  }

  private async call(
    argv: string[],
    serial: string | undefined,
    options: AdbCallOptions,
  ): Promise<AdbExit> {
    const remaining = options.deadline.remainingMs();
    const budget = Math.min(remaining, options.capMs ?? Number.POSITIVE_INFINITY);
    if (budget <= 0) {
      throw timeoutError(
        options.step,
        `before the ${formatDuration(options.deadline.totalMs)} deadline`,
      );
    }
    this.debug(`adb ${shellWords(argv)}`);
    const result = await exec({
      file: this.path,
      args: argv,
      deadlineMs: budget,
      ...(this.options.env === undefined ? {} : { env: this.options.env }),
      ...(options.input === undefined ? {} : { input: options.input }),
      ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
    });

    if (result.kind === "spawn-error") {
      this.debug(`  failed to start: ${result.error.message}`);
      throw new AdbAxiError("ADB_NOT_FOUND", `adb at ${this.path} could not be started`, {
        fields: { detail: result.error.message },
      });
    }
    if (result.kind === "timeout") {
      this.debug(`  killed at the deadline after ${result.durationMs} ms`);
      const partial =
        options.keepPartialOutput === true
          ? { stdout: result.stdout.toString("utf8"), stderr: result.stderr.toString("utf8") }
          : {};
      const limit =
        budget < remaining
          ? `within ${formatDuration(budget)}`
          : `before the ${formatDuration(options.deadline.totalMs)} deadline`;
      throw timeoutError(options.step, limit, partial);
    }

    if (result.kind === "output-limit") {
      this.debug(`  output exceeded the collection limit after ${result.durationMs} ms`);
      throw new AdbAxiError("INVALID_OUTPUT", `${options.step} exceeded the host output limit`, {
        fields: { step: options.step, limit_bytes: options.maxOutputBytes },
      });
    }

    const exitCode = result.exitCode ?? 128 + signalNumber(result.signal);
    this.debug(`  exit ${exitCode} in ${result.durationMs} ms`);
    if (exitCode !== 0) {
      const stderr = result.stderr.toString("utf8");
      const stdout = result.stdout.toString("utf8");
      // adb's own failure exits 1 and prints nothing on stdout, so any other remote exit,
      // or a remote command that printed on stdout, is the remote command's own.
      const code =
        options.remoteOutput !== true
          ? classifyAdbFailure(`${stderr}\n${stdout}`)
          : exitCode === 1 && stdout === ""
            ? classifyShellFailure(stderr)
            : undefined;
      if (code !== undefined) throw adbFailureError(code, serial, `${stderr}\n${stdout}`);
    }
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode,
      durationMs: result.durationMs,
    };
  }

  private debug(line: string): void {
    if (this.options.debug !== true) return;
    const log = this.options.log ?? ((text: string) => process.stderr.write(`${text}\n`));
    log(`debug: ${line}`);
  }
}

/** `limit` says what ran out: the command deadline, or this step's own cap. */
function timeoutError(
  step: string,
  limit: string,
  partial: { stdout?: string; stderr?: string } = {},
): AdbAxiError {
  return new AdbAxiError("TIMEOUT", `${step} did not finish ${limit}`, {
    fields: { step, ...partial },
    help: ["Run the same command with a longer `--timeout`, for example `--timeout 60s`"],
  });
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return ms % 1000 === 0 ? `${ms / 1000} s` : `${(ms / 1000).toFixed(1)} s`;
}

function signalNumber(signal: NodeJS.Signals | null): number {
  const numbers: Partial<Record<NodeJS.Signals, number>> = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGQUIT: 3,
    SIGABRT: 6,
    SIGKILL: 9,
    SIGSEGV: 11,
    SIGPIPE: 13,
    SIGTERM: 15,
  };
  return signal === null ? 0 : (numbers[signal] ?? 0);
}
