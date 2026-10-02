import { spawn } from "node:child_process";

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
  maxOutputBytes?: number;
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
    let drainTimer: NodeJS.Timeout | undefined;

    const child = spawn(options.file, [...options.args], {
      env: options.env ?? process.env,
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });

    const common = (): ExecCommon => ({
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr),
      durationMs: Math.round(performance.now() - started),
      pid: child.pid,
    });

    const finish = (result: ExecResult): void => {
      if (settled) return;
      settled = true;
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

    const collect = (chunks: Buffer[], chunk: Buffer): void => {
      if (settled || outputExceeded) return;
      if (
        options.maxOutputBytes !== undefined &&
        outputBytes + chunk.length > options.maxOutputBytes
      ) {
        outputExceeded = true;
        stdout.length = 0;
        stderr.length = 0;
        child.kill("SIGKILL");
        return;
      }
      outputBytes += chunk.length;
      chunks.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
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
