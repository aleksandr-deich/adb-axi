/**
 * The process `data db` runs one query in: `node sqlite-child.js <database> <deadline-ms>`,
 * with the SQL on stdin. It opens the copy with Node's built-in SQLite, which has no
 * host-file modules or functions (`fsdir`, `zipfile`, `readfile`, ...) and loads no
 * extensions, read-only, in defensive mode, and with an authorizer that blocks host-file
 * operations. A virtual table the copied schema declares can therefore only use the modules
 * compiled in (FTS, R-Tree, dbstat, ...). Queries cannot reach any pre-existing host file. SQLite's own scratch files
 * stay inside adb-axi's private per-query directory, which is removed afterwards. Very large
 * queries are bounded by the deadline, not by a memory cap. The process kills itself when
 * its own deadline passes, so a query never outlives adb-axi for long, even when nothing is
 * left to kill it.
 *
 * Output on stdout, one JSON array per line: the column names, then each row. Integers past
 * 2^53 are strings, so they stay exact. Blobs decode valid UTF-8 sequences as characters and
 * invalid bytes as Latin-1, as `sqlite3 -json` printed them. Errors print
 * `{message, errcode, errstr}` on stderr, with `code` for output errors, and exit 1.
 *
 * Only `node:` imports: the file runs on its own, from `dist` or, under tsx and vitest,
 * as TypeScript with Node's type stripping.
 */
import { readFileSync } from "node:fs";
import { constants, DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";

/** Pragmas that only report, as `PRAGMA x` or `pragma_x(...)`. FTS5 reads `data_version` itself. */
const READ_PRAGMAS = new Set([
  "application_id",
  "auto_vacuum",
  "collation_list",
  "compile_options",
  "data_version",
  "database_list",
  "encoding",
  "foreign_key_check",
  "foreign_key_list",
  "foreign_keys",
  "freelist_count",
  "function_list",
  "index_info",
  "index_list",
  "index_xinfo",
  "integrity_check",
  "journal_mode",
  "module_list",
  "page_count",
  "page_size",
  "pragma_list",
  "quick_check",
  "schema_version",
  "table_info",
  "table_list",
  "table_xinfo",
  "user_version",
]);

/** Why the authorizer last refused something, to say more than SQLite's "not authorized". */
let refused: string | undefined;

function authorize(action: number, arg1: string | null): number {
  switch (action) {
    case constants.SQLITE_SELECT:
    case constants.SQLITE_READ:
    case constants.SQLITE_FUNCTION:
    case constants.SQLITE_RECURSIVE:
    case constants.SQLITE_INSERT:
    case constants.SQLITE_UPDATE:
    case constants.SQLITE_DELETE:
      return constants.SQLITE_OK;
    case constants.SQLITE_PRAGMA:
      if (arg1 !== null && READ_PRAGMAS.has(arg1.toLowerCase())) return constants.SQLITE_OK;
      refused = `PRAGMA ${arg1 ?? ""} is not one data db reads`;
      return constants.SQLITE_DENY;
    case constants.SQLITE_ATTACH:
      refused = "ATTACH is not allowed; data db reads only the copied database";
      return constants.SQLITE_DENY;
    default:
      refused = "data db only reads; the copy is read-only";
      return constants.SQLITE_DENY;
  }
}

type Value = string | number | null;

function value(cell: unknown): Value {
  if (cell === null || typeof cell === "string") return cell;
  if (typeof cell === "bigint") {
    const number = Number(cell);
    return Number.isSafeInteger(number) ? number : String(cell);
  }
  if (typeof cell === "number") {
    if (Number.isFinite(cell)) return cell;
    throw Object.assign(new TypeError("query returned a non-finite numeric value"), {
      code: "INVALID_OUTPUT",
    });
  }
  if (cell instanceof Uint8Array) return blobText(cell);
  throw new TypeError(`unexpected SQLite value of type ${typeof cell}`);
}

function blobText(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("latin1")
    .replace(
      /[\xc2-\xdf][\x80-\xbf]|\xe0[\xa0-\xbf][\x80-\xbf]|[\xe1-\xec\xee-\xef][\x80-\xbf]{2}|\xed[\x80-\x9f][\x80-\xbf]|\xf0[\x90-\xbf][\x80-\xbf]{2}|[\xf1-\xf3][\x80-\xbf]{3}|\xf4[\x80-\x8f][\x80-\xbf]{2}/g,
      (sequence) => Buffer.from(sequence, "latin1").toString("utf8"),
    );
}

/** Write one line, waiting while the pipe is full so a large result never piles up here. */
async function writeLine(line: unknown[]): Promise<void> {
  if (!process.stdout.write(`${JSON.stringify(line)}\n`)) {
    await new Promise<void>((resolve) =>
      process.stdout.once("drain", () => {
        resolve();
      }),
    );
  }
}

async function run(database: string, sql: string): Promise<void> {
  const db = new DatabaseSync(database, {
    readOnly: true,
    defensive: true,
    allowExtension: false,
    // As the sqlite3 shell and Android's SQLite do: app schemas and queries use them.
    enableDoubleQuotedStringLiterals: true,
  });
  db.setAuthorizer(authorize);
  const statement = db.prepare(sql);
  statement.setReadBigInts(true);
  statement.setReturnArrays(true);
  await writeLine(statement.columns().map((column) => column.name));
  for (const row of statement.iterate() as Iterable<unknown[]>) {
    await writeLine(row.map(value));
  }
  db.close();
}

/**
 * Kill this process once `ms` have passed. A step of a query runs inside SQLite without
 * returning to JavaScript, so the timer runs on a thread of its own; it does not keep the
 * process alive once the query is done.
 */
function killAfter(ms: number): void {
  const watchdog = new Worker(
    `setTimeout(() => process.kill(process.pid, "SIGKILL"), require("node:worker_threads").workerData);`,
    { eval: true, workerData: ms },
  );
  watchdog.unref();
}

const [database, deadline] = process.argv.slice(2);
const deadlineMs = Number(deadline);
if (database === undefined || !Number.isSafeInteger(deadlineMs) || deadlineMs < 0) {
  throw new Error("usage: sqlite-child <database> <deadline-ms>");
}
killAfter(deadlineMs);
try {
  await run(database, readFileSync(0, "utf8"));
} catch (error) {
  const { message, errcode, errstr, code } = error as {
    code?: unknown;
    message?: unknown;
    errcode?: unknown;
    errstr?: unknown;
  };
  const text = String(message ?? error);
  process.stderr.write(
    `${JSON.stringify({
      message: refused !== undefined && /not authorized/.test(text) ? `${text}: ${refused}` : text,
      errcode: typeof errcode === "number" ? errcode : null,
      errstr: typeof errstr === "string" ? errstr : null,
      ...(code === "INVALID_OUTPUT" ? { code } : {}),
    })}\n`,
  );
  process.exitCode = 1;
}
