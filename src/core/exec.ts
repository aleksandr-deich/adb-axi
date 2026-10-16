import { spawn } from "node:child_process";
import { onInterrupt } from "./interrupt.js";

/**
 * The most stdout and stderr together that a call keeps unless it names its own limit. The
 * device reads adb-axi parses print far less (a whole `dumpsys package packages` is under 1 MB
 * on an emulator); past it a runaway command is stopped before it fills host memory.
 */
export const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export interface ExecOptions {
  /** The executable. Always spawned directly with an argument array, never through a shell. */
  file: string;
  args: readonly string[];
  /** Hard deadline in milliseconds. The child is killed with SIGKILL when it passes. */
  deadlineMs: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Bytes written to the child's stdin, which is then closed. Without it stdin is closed at once. */
  input?: string | Uint8Array;
  /**
   * The most stdout and stderr together kept in memory, `DEFAULT_MAX_OUTPUT_BYTES` when unset.
   * Past it the child is killed and the result is `output-limit` with nothing kept, unless
   * a `sink` takes the output.
   */
  maxOutputBytes?: number;
  /**
   * Receives every chunk of output as it arrives. The child then runs on past
   * `maxOutputBytes`, which only bounds the copy kept in memory: its first bytes. Must not throw.
   */
  sink?: (stream: "stdout" | "stderr", chunk: Buffer) => void;
  signal?: AbortSignal;
  /**
   * Kill the child with SIGKILL when SIGINT or SIGTERM ends adb-axi. Only for a child that
   * adb-axi alone owns and that has no use once adb-axi is gone, such as a query process.
   */
  killOnInterrupt?: boolean;
}

interface ExecCommon {
  stdout: Buffer;
  stderr: Buffer;
  durationMs: number;
  pid: number | undefined;
}

export type ExecResult =
  /** The child exited on its own (or was killed by someone else, `signal` set). */
  | (ExecCommon & { kind: "exited"; exitCode: number | null; signal: NodeJS.Signals | null })
  /** The deadline passed; the child was killed. Output up to that point is kept. */
  | (ExecCommon & { kind: "timeout" })
  | (ExecCommon & { kind: "output-limit" })
  /** The child could not be started (for example ENOENT). */
  | (ExecCommon & { kind: "spawn-error"; error: Error });

/**
 * Grace period for stdio to drain after the child exits. A grandchild that inherited the
 * pipes (for example an adb server started on demand) must not hold the call open.
 */
const DRAIN_GRACE_MS = 200;

/**
 * Run a host process with a deadline. Never rejects: every outcome is an `ExecResult`,
 * so callers map exits, timeouts and spawn failures to typed errors in one place.
 */
export function exec(options: ExecOptions): Promise<ExecResult> {
  return new Promise((resolve) => {
    const started = performance.now();
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    let timedOut = false;
    let outputExceeded = false;
    let outputBytes = 0;
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    let drainTimer: NodeJS.Timeout | undefined;

    const child = spawn(options.file, [...options.args], {
      env: options.env ?? process.env,
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });

    const abort = (): void => {
      child.kill("SIGKILL");
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted === true) abort();

    const stopKillOnInterrupt = options.killOnInterrupt
      ? onInterrupt(() => {
          child.kill("SIGKILL");
        })
      : undefined;

    const common = (): ExecCommon => ({
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr),
      durationMs: Math.round(performance.now() - started),
      pid: child.pid,
    });

    const finish = (result: ExecResult): void => {
      if (settled) return;
      settled = true;
      stopKillOnInterrupt?.();
      options.signal?.removeEventListener("abort", abort);
      clearTimeout(deadlineTimer);
      clearTimeout(drainTimer);
      child.stdout.destroy();
      child.stderr.destroy();
      resolve(result);
    };

    const deadlineTimer = setTimeout(
      () => {
        timedOut = true;
        child.kill("SIGKILL");
      },
      Math.max(0, options.deadlineMs),
    );

    const collect = (stream: "stdout" | "stderr", chunks: Buffer[], chunk: Buffer): void => {
      if (settled || outputExceeded) return;
      options.sink?.(stream, chunk);
      if (outputBytes + chunk.length > maxOutputBytes) {
        if (options.sink !== undefined) {
          const room = maxOutputBytes - outputBytes;
          if (room > 0) chunks.push(chunk.subarray(0, room));
          outputBytes = maxOutputBytes;
          return;
        }
        outputExceeded = true;
        stdout.length = 0;
        stderr.length = 0;
        child.kill("SIGKILL");
        return;
      }
      outputBytes += chunk.length;
      chunks.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      collect("stdout", stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      collect("stderr", stderr, chunk);
    });
    child.stdin.on("error", () => {
      // The child may exit without reading its input; that is not a failure of the call.
    });

    child.on("error", (error) => {
      finish({ kind: "spawn-error", error, ...common() });
    });

    child.on("exit", (exitCode, signal) => {
      if (timedOut || outputExceeded) {
        finish({ kind: timedOut ? "timeout" : "output-limit", ...common() });
        return;
      }
      drainTimer = setTimeout(() => {
        finish(
          outputExceeded
            ? { kind: "output-limit", ...common() }
            : { kind: "exited", exitCode, signal, ...common() },
        );
      }, DRAIN_GRACE_MS);
    });

    child.on("close", (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (timedOut || outputExceeded) {
        finish({ kind: timedOut ? "timeout" : "output-limit", ...common() });
        return;
      }
      finish({ kind: "exited", exitCode, signal, ...common() });
    });

    if (options.input === undefined) {
      child.stdin.end();
    } else {
      child.stdin.end(options.input);
    }
  });
}

/** True while a process with this pid exists. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}
