import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Deadline } from "../../core/deadline.js";
import { AdbAxiError } from "../../core/errors.js";
import { exec } from "../../core/exec.js";

export type Cell = string | number | boolean | null;
export type Row = Record<string, Cell>;

/** The most output of a query adb-axi collects; past it the query needs a narrower SELECT. */
const MAX_RESULT_BYTES = 64 * 1024 * 1024;

/** The first Node.js with what the query process needs from `node:sqlite` (`setAuthorizer`, `defensive`). */
export const SQLITE_NODE = [24, 12] as const;

/** The query process, next to this module: `.js` from `dist`, `.ts` under tsx and vitest. */
const CHILD = fileURLToPath(
  new URL(`./sqlite-child${extname(fileURLToPath(import.meta.url))}`, import.meta.url),
);

/** Fail with `NODE_TOO_OLD` unless this Node.js can run the query process. */
export function assertQueryRuntime(version: string = process.versions.node): void {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  const [needMajor, needMinor] = SQLITE_NODE;
  if (major > needMajor || (major === needMajor && minor >= needMinor)) return;
  throw new AdbAxiError(
    "NODE_TOO_OLD",
    `data db needs Node.js ${needMajor}.${needMinor} or newer; this is Node.js ${version}`,
    {
      fields: { required: `>=${needMajor}.${needMinor}.0`, node: version },
      help: [`Install Node.js ${needMajor}.${needMinor} or newer, then run the command again`],
    },
  );
}

export interface QueryRequest {
  /** The copied database file; its `-wal` file sits next to it. */
  database: string;
  sql: string;
  /** Directory the query process runs in, so a relative path names nothing outside it. */
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
 * Run one query against the copy in its own Node.js process and return its rows. The SQL
 * goes in on stdin. The process opens the copy read-only with Node's built-in SQLite, which
 * has no host-file functions or modules, and an authorizer that allows only reads, so neither
 * the query nor the copied schema can read, list or write a host file other than the copy
 * (see `sqlite-child.ts`). Its own process lets the deadline kill a query that never ends.
 */
export async function runQuery(request: QueryRequest): Promise<Row[]> {
  const result = await exec({
    file: process.execPath,
    args: ["--no-warnings", CHILD, request.database],
    deadlineMs: request.deadline.remainingMs(),
    cwd: request.workDir,
    env: request.env,
    input: request.sql,
    maxOutputBytes: MAX_RESULT_BYTES,
  });

  switch (result.kind) {
    case "spawn-error":
      throw new AdbAxiError("INTERNAL_ERROR", "the query process could not be started", {
        fields: { detail: result.error.message },
      });
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
      if (result.exitCode === 0) return readRows(request.label, result.stdout.toString("utf8"));
      throw sqlError(request.label, result.stderr.toString("utf8"), result.exitCode);
  }
}

/**
 * The rows the query process printed: a line of column names, then a line per row. A result
 * with two columns of the same name (`SELECT a.id, b.id`) keeps both, the later ones renamed
 * `id_2`, `id_3`.
 */
export function readRows(label: string, stdout: string): Row[] {
  const [header, ...lines] = stdout.split("\n").filter((line) => line !== "");
  if (header === undefined) throw unreadable(label, "no column line");
  const names = parseLine(label, header);
  if (!names.every((name) => typeof name === "string")) {
    throw unreadable(label, "a column name is not a string");
  }
  return lines.map((line) => {
    const cells = parseLine(label, line);
    if (cells.length !== names.length) {
      throw unreadable(label, `a row has ${cells.length} cells for ${names.length} columns`);
    }
    const row: Row = {};
    names.forEach((name, i) => {
      // `defineProperty`, because a column named `__proto__` must stay a column.
      Object.defineProperty(row, uniqueName(row, name), {
        value: cells[i] ?? null,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    });
    return row;
  });
}

function parseLine(label: string, line: string): Cell[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw unreadable(label, error instanceof Error ? error.message : String(error));
  }
  if (!Array.isArray(parsed)) throw unreadable(label, "a line is not an array");
  return parsed as Cell[];
}

function unreadable(label: string, detail: string): AdbAxiError {
  return new AdbAxiError(
    "INVALID_OUTPUT",
    `the query printed a result for ${label} adb-axi cannot read`,
    { fields: { detail } },
  );
}

function uniqueName(row: Row, name: string): string {
  if (!Object.hasOwn(row, name)) return name;
  for (let n = 2; ; n++) {
    const candidate = `${name}_${n}`;
    if (!Object.hasOwn(row, candidate)) return candidate;
  }
}

/** SQLite's message from the query process, or what the process printed when it had none. */
function sqlError(label: string, stderr: string, exitCode: number | null): AdbAxiError {
  const text = stderr.trim();
  let reported: { message?: unknown; errstr?: unknown; errcode?: unknown } | undefined;
  try {
    reported = JSON.parse(text) as typeof reported;
  } catch {
    reported = undefined;
  }
  const message =
    typeof reported?.message === "string"
      ? reported.message
      : `the query process exited ${exitCode ?? "without a status"}`;
  const detail =
    typeof reported?.errstr === "string"
      ? `${message} (${reported.errstr}, code ${String(reported.errcode)})`
      : text;
  return new AdbAxiError("SQL_ERROR", `SQLite rejected the query on ${label}: ${message}`, {
    ...(detail === "" ? {} : { fields: { detail: detail.slice(0, 500) } }),
    help: ["Check the table and column names with `SELECT name, sql FROM sqlite_master`"],
  });
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return ms % 1000 === 0 ? `${ms / 1000} s` : `${(ms / 1000).toFixed(1)} s`;
}
