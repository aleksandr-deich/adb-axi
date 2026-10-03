import { findSdkTool } from "../../adb/locate.js";
import type { Deadline } from "../../core/deadline.js";
import { AdbAxiError } from "../../core/errors.js";
import { exec } from "../../core/exec.js";

/** The most output of sqlite3 adb-axi collects; past it the query needs a narrower SELECT. */
const MAX_RESULT_BYTES = 64 * 1024 * 1024;

/** Locate the host sqlite3 like adb (7.3 and 7.11) or fail with `SQLITE_NOT_FOUND`. */
export function locateSqlite3(env: NodeJS.ProcessEnv): string {
  const { path, searched } = findSdkTool("sqlite3", env);
  if (path !== undefined) return path;
  throw new AdbAxiError("SQLITE_NOT_FOUND", "sqlite3 was not found on this computer", {
    fields: { searched },
    help: [
      "Install sqlite3 (the Android SDK platform-tools ship it, or use your package manager), or set ANDROID_HOME to the SDK directory, then run the command again",
    ],
  });
}

export interface QueryRequest {
  sqlite3: string;
  /** The copied database file; its `-wal` file sits next to it. */
  database: string;
  sql: string;
  /** Directory the process runs in and treats as its home, so no user config is read. */
  workDir: string;
  env: NodeJS.ProcessEnv;
  /** The command's one deadline; the query gets what is left of it. */
  deadline: Deadline;
  /** Names the step in a `TIMEOUT` error. */
  step: string;
  /** What to show in an error about the query: the database name. */
  label: string;
}

/**
 * Run one query against the copy with `sqlite3 -safe -readonly -json` and return what it
 * printed. The SQL goes in on stdin, never as an argument, so text starting with `-`
 * is not read as an option. Nothing the query does can reach the device or the host
 * outside `workDir`: the copy is opened read-only and safe mode refuses host-file functions.
 */
export async function runQuery(request: QueryRequest): Promise<string> {
  const result = await exec({
    file: request.sqlite3,
    args: ["-safe", "-readonly", "-batch", "-json", request.database],
    deadlineMs: request.deadline.remainingMs(),
    cwd: request.workDir,
    env: { ...request.env, HOME: request.workDir, USERPROFILE: request.workDir },
    // The newline and `;` end a statement that finishes in a `--` comment or lacks its `;`.
    input: `${request.sql}\n;\n`,
    maxOutputBytes: MAX_RESULT_BYTES,
  });

  switch (result.kind) {
    case "spawn-error":
      throw new AdbAxiError(
        "SQLITE_NOT_FOUND",
        `sqlite3 at ${request.sqlite3} could not be started`,
        {
          fields: { detail: result.error.message },
        },
      );
    case "timeout":
      throw new AdbAxiError(
        "TIMEOUT",
        `${request.step} did not finish before the ${formatDuration(request.deadline.totalMs)} deadline`,
        {
          fields: { step: request.step },
          help: ["Run the same command with a longer `--timeout`, for example `--timeout 60s`"],
        },
      );
    case "output-limit":
      throw new AdbAxiError(
        "INVALID_OUTPUT",
        `the result of the query on ${request.label} is larger than ${MAX_RESULT_BYTES / 1024 / 1024} MB`,
        {
          fields: { step: request.step, limit_bytes: MAX_RESULT_BYTES },
          help: ["Narrow the query, for example with `WHERE` or `LIMIT`"],
        },
      );
    case "exited":
      if (result.exitCode === 0) return result.stdout.toString("utf8");
      throw sqlError(request.label, result.stderr.toString("utf8"), result.exitCode);
  }
}

/** sqlite3's message, without its `Parse error near line 1:` style prefix, and the full text. */
function sqlError(label: string, stderr: string, exitCode: number | null): AdbAxiError {
  const text = stderr.trim();
  const first = text.split(/\r?\n/)[0] ?? "";
  const message =
    first.replace(/^(?:Parse error|Runtime error|Error)[^:]*:\s*/, "") ||
    `sqlite3 exited ${exitCode ?? "without a status"}`;
  return new AdbAxiError("SQL_ERROR", `sqlite3 rejected the query on ${label}: ${message}`, {
    ...(text === "" ? {} : { fields: { detail: text.slice(0, 500) } }),
    help: ["Check the table and column names with `SELECT name, sql FROM sqlite_master`"],
  });
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return ms % 1000 === 0 ? `${ms / 1000} s` : `${(ms / 1000).toFixed(1)} s`;
}
