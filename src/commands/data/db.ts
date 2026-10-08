import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execOut } from "../../adb/execout.js";
import { assertPackageName } from "../../android/component.js";
import { AdbAxiError } from "../../core/errors.js";
import { render, runHint, shellWords, type Output } from "../../core/output.js";
import { truncateField, writeFullOutput, MAX_FIELD_CHARS } from "../../core/truncate.js";
import { lifecycleCommand } from "../app/process.js";
import { targetSerial } from "../app/shared.js";
import { defineCommand } from "../define.js";
import type { CommandContext } from "../types.js";
import { listDatabases, runAsRefusal, type DatabaseFile } from "./databases.js";
import { assertReadOnlySql } from "./sql-guard.js";
import { assertQueryRuntime, runQuery, type Row } from "./sqlite-query.js";

/** Rows shown by default, as many as the log line cap (7.8). */
const MAX_ROWS = 50;
/** The most bytes of one database file adb-axi copies into memory. */
const MAX_COPY_BYTES = 256 * 1024 * 1024;

const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "latin1");
/** The two magic numbers a WAL file starts with (little-endian and big-endian checksums). */
const WAL_MAGICS = [0x377f0682, 0x377f0683];

export const dataDb = defineCommand({
  path: ["data", "db"],
  summary:
    "List an app's databases, or run one read-only query on a copy that includes the WAL. " +
    "The copy is taken file by file while the app runs, so a write made during it can be missed",
  positionals: [
    { name: "pkg", description: "Package name of a debuggable app", required: true },
    {
      name: "sql",
      description:
        "One read-only statement: SELECT, WITH, VALUES, EXPLAIN or PRAGMA (64 MB result limit). Without it the databases are listed",
      required: false,
    },
  ],
  flags: [
    {
      name: "--db",
      type: "string",
      valueName: "<name>",
      description: "Database file name, required when the app has several",
    },
    {
      name: "--full",
      type: "boolean",
      description: `Write every row, and long cells in full, to a file when more than ${MAX_ROWS} rows or a long cell were cut`,
    },
  ],
  examples: [
    "adb-axi data db com.example.notes",
    "adb-axi data db com.example.notes 'SELECT id, title FROM note LIMIT 3'",
  ],
  shipped: true,
  run: async (context) => {
    const pkg = String(context.positionals.pkg);
    assertPackageName(pkg);
    const sql = typeof context.positionals.sql === "string" ? context.positionals.sql : undefined;
    const requested = typeof context.flags.db === "string" ? context.flags.db : undefined;
    const full = context.flags.full === true;

    if (sql === undefined) {
      if (requested !== undefined || full) {
        throw new AdbAxiError(
          "VALIDATION_ERROR",
          "--db and --full apply to a query, and none was given",
          {
            help: [
              runHint(
                lifecycleCommand(context, ["data", "db", pkg, "<sql>"]),
                "to run one, or leave the flags out to list the databases",
              ),
            ],
          },
        );
      }
      return listing(context, pkg, await listDatabases(context, pkg));
    }

    assertReadOnlySql(sql);
    assertQueryRuntime();
    const databases = await listDatabases(context, pkg);
    const database = pick(context, pkg, databases, requested);
    return query(context, { pkg, database, sql, full });
  },
});

function listing(context: CommandContext, pkg: string, databases: DatabaseFile[]): Output {
  const first = databases[0];
  const several = databases.length > 1;
  return {
    count: `${databases.length} ${databases.length === 1 ? "database" : "databases"}`,
    databases: databases.map((database) => ({
      name: database.name,
      size: formatSize(database.size),
      wal: database.walSize !== null,
    })),
    ...(first === undefined
      ? {}
      : {
          help: [
            runHint(
              lifecycleCommand(context, [
                "data",
                "db",
                pkg,
                "SELECT name, sql FROM sqlite_master",
                ...(several ? ["--db", first.name] : []),
              ]),
              "to read its schema",
            ),
          ],
        }),
  };
}

/** The database a query runs on: `--db`, or the only one the app has. */
function pick(
  context: CommandContext,
  pkg: string,
  databases: readonly DatabaseFile[],
  requested: string | undefined,
): DatabaseFile {
  const names = databases.map((database) => database.name);
  const listCommand = lifecycleCommand(context, ["data", "db", pkg]);
  if (requested !== undefined) {
    const found = databases.find((database) => database.name === requested);
    if (found !== undefined) return found;
    throw new AdbAxiError("DB_NOT_FOUND", `${pkg} has no database named ${requested}`, {
      fields: { databases: names },
      help: [runHint(listCommand, "to list its databases")],
    });
  }
  const [only] = databases;
  if (only === undefined) {
    throw new AdbAxiError("DB_NOT_FOUND", `${pkg} has no databases`, {
      fields: { databases: names },
      help: ["Run the app so it creates its database, then run the command again"],
    });
  }
  if (databases.length === 1) return only;
  throw new AdbAxiError(
    "VALIDATION_ERROR",
    `${pkg} has ${databases.length} databases; pick one with --db`,
    {
      fields: { databases: names },
      help: [
        runHint(
          lifecycleCommand(context, ["data", "db", pkg, "<sql>", "--db", "<name>"]),
          "with one of the names above",
        ),
      ],
    },
  );
}

interface QueryPlan {
  pkg: string;
  database: DatabaseFile;
  sql: string;
  full: boolean;
}

async function query(context: CommandContext, plan: QueryPlan): Promise<Output> {
  const { database, sql } = plan;
  const dir = mkdtempSync(join(tmpdir(), "adb-axi-db-"));
  try {
    chmodSync(dir, 0o700);
    const walCopied = await copyDatabase(context, plan, dir);
    const copiedAt = new Date();
    const rows = await runQuery({
      database: join(dir, "db"),
      sql,
      workDir: dir,
      env: context.env,
      deadline: context.deadline,
      step: `querying the copy of ${database.name}`,
      label: database.name,
    });
    return present(
      context,
      plan,
      rows,
      `${database.name} (${walCopied ? "with" : "no"} WAL, copied ${clock(copiedAt)})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Copy the database and its `-wal` into `dir` as `db` and `db-wal`, and say whether a log
 * with content was copied. Room keeps recent writes only in the log, so the main file alone
 * would miss them. The `-shm` file is not copied: it is an index of the log that SQLite
 * rebuilds from the log itself, and a snapshot taken at another moment than the log's could
 * disagree with it. The log goes first, so the main file is never older than its log.
 */
async function copyDatabase(
  context: CommandContext,
  plan: QueryPlan,
  dir: string,
): Promise<boolean> {
  const { pkg, database } = plan;
  let walCopied = false;
  if (database.walSize !== null) {
    const wal = await pull(context, pkg, `${database.name}-wal`);
    if (wal.length > 0) {
      if (!isWal(wal)) throw notSqlite(context, pkg, `${database.name}-wal`, wal, "a WAL file");
      writeFileSync(join(dir, "db-wal"), wal);
      walCopied = true;
    }
  }
  const main = await pull(context, pkg, database.name);
  if (main.length === 0 || !main.subarray(0, SQLITE_HEADER.length).equals(SQLITE_HEADER)) {
    throw notSqlite(context, pkg, database.name, main, "a SQLite database");
  }
  writeFileSync(join(dir, "db"), main);
  return walCopied;
}

/**
 * The bytes of one file in `databases/`. `exec-out` has no stderr and exits 0 whatever
 * the remote command did (S1), so a failure arrives as these bytes: callers validate them.
 */
function pull(context: CommandContext, pkg: string, name: string): Promise<Buffer> {
  return execOut(
    context.adb(),
    targetSerial(context),
    ["run-as", pkg, "cat", shellWords([`databases/${name}`])],
    {
      deadline: context.deadline,
      step: `copying databases/${name} of ${pkg}`,
      maxOutputBytes: MAX_COPY_BYTES,
    },
  );
}

function isWal(bytes: Buffer): boolean {
  return bytes.length >= 32 && WAL_MAGICS.includes(bytes.readUInt32BE(0));
}

/** What `exec-out` copied is not the file asked for: a `run-as` refusal or the error text of `cat`. */
function notSqlite(
  context: CommandContext,
  pkg: string,
  name: string,
  bytes: Buffer,
  expected: string,
): AdbAxiError {
  const sample = bytes.subarray(0, 200).toString("utf8").trim();
  const refusal = runAsRefusal(context, pkg, sample);
  if (refusal !== undefined) return refusal;
  const printable = /^[\x20-\x7e\r\n\t]*$/.test(sample);
  return new AdbAxiError(
    "INVALID_OUTPUT",
    `the copy of databases/${name} is not ${expected} (${bytes.length} bytes)`,
    {
      fields: {
        step: `copying databases/${name} of ${pkg}`,
        ...(printable && sample !== "" ? { detail: sample } : {}),
      },
      help: [
        runHint(lifecycleCommand(context, ["data", "db", pkg]), "to check the file is still there"),
      ],
    },
  );
}

/** The result as TOON rows, capped at 50, with the whole result in a file for `--full`. */
function present(context: CommandContext, plan: QueryPlan, rows: Row[], label: string): Output {
  const shown = rows.slice(0, MAX_ROWS).map(shortenCells);
  const cutRows = rows.length > MAX_ROWS;
  const cutCells = shown.some((row, i) => Object.entries(row).some(([k, v]) => v !== rows[i]?.[k]));
  const out: Output = { db: label, ...(rows.length === 0 ? { count: "0 rows" } : {}), rows: shown };
  if (cutRows) out.shown = `${shown.length} of ${rows.length} rows`;
  if (!cutRows && !cutCells) return out;

  if (plan.full) {
    out.full = writeFullOutput(
      `db-${plan.database.name}-${clock(new Date()).replaceAll(":", "")}`,
      `${render({ rows }, context.mode)}\n`,
      (path, content) => {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content, { flag: "wx" });
      },
    );
  } else {
    out.help = [
      `Run the same command with \`--full\` to write ${cutRows ? `all ${rows.length} rows` : "the long cells"} to a file`,
    ];
  }
  return out;
}

function shortenCells(row: Row): Row {
  const cut: Row = {};
  for (const [name, value] of Object.entries(row)) {
    Object.defineProperty(cut, name, {
      value: typeof value === "string" ? truncateField(value, MAX_FIELD_CHARS) : value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return cut;
}

/** `10:14:02`, the host's local time. */
function clock(at: Date): string {
  return [at.getHours(), at.getMinutes(), at.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

/** `4 KB`, `44.3 KB`, `1.2 MB`: sizes the way `app info` prints them. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Number(kb.toFixed(1))} KB`;
  return `${Number((kb / 1024).toFixed(1))} MB`;
}
