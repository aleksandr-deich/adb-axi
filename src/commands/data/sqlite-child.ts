/**
 * The process `data db` runs one query in: `node sqlite-child.js <database>`, with the SQL
 * on stdin. It opens the copy with Node's built-in SQLite, which has no host-file modules or
 * functions (`fsdir`, `zipfile`, `readfile`, ...) and loads no extensions, read-only, in
 * defensive mode, and with an authorizer that blocks host-file operations. A virtual table the
 * copied schema declares can therefore only use the modules compiled in (FTS, R-Tree,
 * dbstat, ...), and the query cannot attach another file or change where SQLite writes.
 *
 * Output on stdout, one JSON array per line: the column names, then each row. Integers past
 * 2^53 are strings, so they stay exact, and blobs are strings of their bytes as Latin-1, as
 * `sqlite3 -json` printed them. On an SQLite error it prints `{message, errcode, errstr}` on
 * stderr and exits 1.
 *
 * Only `node:` imports: the file runs on its own, from `dist` or, under tsx and vitest,
 * as TypeScript with Node's type stripping.
 */
import { readFileSync } from "node:fs";
import { constants, DatabaseSync } from "node:sqlite";

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
    return Number.isNaN(cell) ? null : cell > 0 ? "Inf" : "-Inf";
  }
  if (cell instanceof Uint8Array) return Buffer.from(cell).toString("latin1");
  throw new TypeError(`unexpected SQLite value of type ${typeof cell}`);
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
  const maxHeapBytes = 512 * 1024 * 1024;
  db.exec(`PRAGMA temp_store=MEMORY; PRAGMA hard_heap_limit=${maxHeapBytes};`);
  if (db.prepare("PRAGMA temp_store").get()?.temp_store !== 2) {
    throw new Error("data db could not enable memory-only temporary storage");
  }
  if (db.prepare("PRAGMA hard_heap_limit").get()?.hard_heap_limit !== maxHeapBytes) {
    throw new Error("data db could not configure the SQLite memory limit");
  }
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

const [database] = process.argv.slice(2);
if (database === undefined) throw new Error("usage: sqlite-child <database>");
try {
  await run(database, readFileSync(0, "utf8"));
} catch (error) {
  const { message, errcode, errstr } = error as {
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
    })}\n`,
  );
  process.exitCode = 1;
}
