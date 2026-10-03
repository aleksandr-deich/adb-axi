import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { decode } from "@toon-format/toon";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findSdkTool } from "../../src/adb/locate.js";
import { isProcessAlive } from "../../src/core/exec.js";
import { createFakeAdb, FIXTURES_DIR, type FakeAdb } from "../fake-adb/harness.js";
import type { Response, Rule } from "../fake-adb/scenario.js";
import { runCli, type CliRun } from "../helpers/run.js";

vi.setConfig({ testTimeout: 40_000 });

const SERIAL = "emulator-5554";
const PKG = "dev.probe";
const ONE_ONLINE = `List of devices attached\n${SERIAL}          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1\n\n`;
const CAPTURED = join(FIXTURES_DIR, "captured", "35");
const MARGIN_MS = 1500;

/** The host sqlite3 the tests run for real, found the way adb-axi finds it. */
const SQLITE3 = findSdkTool("sqlite3").path;
const needsSqlite3 = it.skipIf(SQLITE3 === undefined);
const NO_SQLITE3_REASON = "host sqlite3 is not installed, so the real-sqlite3 cases are skipped";
if (SQLITE3 === undefined) console.warn(NO_SQLITE3_REASON);

let fake: FakeAdb | undefined;
const scratch: string[] = [];
afterEach(() => {
  fake?.cleanup();
  fake = undefined;
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "adb-axi-db-test-"));
  scratch.push(dir);
  return dir;
}

const lsCall = (pkg = PKG): string[] => ["-s", SERIAL, "shell", `run-as ${pkg} ls -l databases`];
const catCall = (name: string, pkg = PKG): string[] => [
  "-s",
  SERIAL,
  "exec-out",
  "run-as",
  pkg,
  "cat",
  `databases/${name}`,
];

/** `ls -l` output as toybox prints it, for files of the given sizes. */
function lsOutput(files: Record<string, number>): string {
  const lines = Object.entries(files).map(
    ([name, size]) =>
      `-rw-rw---- 1 u0_a213 u0_a213 ${String(size).padStart(5)} 2026-10-01 07:57 ${name}`,
  );
  return `total ${lines.length * 4}\n${lines.join("\n")}\n`;
}

function device(rules: Rule[], env: Record<string, string | undefined> = {}): FakeAdb {
  fake = createFakeAdb(
    {
      description: "One online emulator answering run-as reads of an app's databases",
      synthetic: true,
      rules: [{ match: ["devices", "-l"], respond: { stdout: ONE_ONLINE } }, ...rules],
    },
    { env },
  );
  return fake;
}

/** A device whose `databases/` holds these files, each served from a file on the host. */
function deviceWith(
  files: Record<string, string>,
  env: Record<string, string | undefined> = {},
): FakeAdb {
  const sizes = Object.fromEntries(
    Object.entries(files).map(([name, path]) => [name, statSync(path).size]),
  );
  return device(
    [
      { match: lsCall(), respond: { stdout: lsOutput(sizes) } },
      ...Object.entries(files).map(([name, path]): Rule => ({
        match: catCall(name),
        respond: { stdoutFile: path },
      })),
    ],
    env,
  );
}

/** Make a database with the real sqlite3, as a file in a scratch directory. */
function makeDb(sql: string, name = "app.db"): string {
  const path = join(scratchDir(), name);
  execFileSync(SQLITE3 ?? "sqlite3", [path], { input: sql });
  return path;
}

/**
 * A database as an app with an open connection leaves it: the newest row is only in the
 * `-wal` file. Real sqlite3 writes it; the process is killed with the connection open (so
 * it never checkpoints and deletes the log) after the files are copied.
 */
async function makeWalDb(): Promise<{ db: string; wal: string }> {
  const dir = scratchDir();
  const live = join(dir, "live.db");
  const child = spawn(SQLITE3 ?? "sqlite3", [live], { stdio: ["pipe", "pipe", "inherit"] });
  let seen = "";
  const ready = new Promise<void>((resolve) => {
    child.stdout.on("data", (chunk: Buffer) => {
      seen += chunk.toString("utf8");
      if (seen.includes("ready")) resolve();
    });
  });
  child.stdin.write(
    [
      "PRAGMA journal_mode=WAL;",
      "CREATE TABLE note(id INTEGER PRIMARY KEY, title TEXT);",
      "INSERT INTO note(title) VALUES ('checkpointed');",
      "PRAGMA wal_checkpoint(TRUNCATE);",
      "INSERT INTO note(title) VALUES ('only in the wal');",
      "SELECT 'ready';",
      "",
    ].join("\n"),
  );
  await ready;
  const db = join(dir, "copy.db");
  copyFileSync(live, db);
  copyFileSync(`${live}-wal`, `${db}-wal`);
  const exited = new Promise((resolve) => child.on("exit", resolve));
  child.kill("SIGKILL");
  await exited;
  return { db, wal: `${db}-wal` };
}

/** Run in both formats; they must carry the same data, field for field. */
async function both(
  f: FakeAdb,
  args: string[],
): Promise<{ toon: CliRun; json: CliRun; data: Record<string, unknown> }> {
  const toon = await runCli(["data", "db", ...args], f.env);
  const json = await runCli(["data", "db", ...args, "--json"], f.env);
  expect(json.exitCode).toBe(toon.exitCode);
  const data = JSON.parse(json.stdout) as Record<string, unknown>;
  expect(normalize(data)).toEqual(
    normalize(decode(toon.stdout.trimEnd()) as Record<string, unknown>),
  );
  return { toon, json, data };
}

/** Two runs differ in the copy time and in the file a `--full` run wrote. */
function normalize(data: Record<string, unknown>): Record<string, unknown> {
  const { full, ...rest } = data;
  return {
    ...rest,
    ...(typeof rest.db === "string"
      ? { db: rest.db.replace(/copied \d\d:\d\d:\d\d/, "copied <time>") }
      : {}),
    ...(full === undefined ? {} : { full: "<file>" }),
  };
}

function errorOf(run: CliRun): Record<string, unknown> {
  return decode(run.stdout.trimEnd()) as Record<string, unknown>;
}

const noDeviceReads = (f: FakeAdb): void => {
  expect(
    f.calls().filter((call) => call.argv.includes("run-as") || call.argv.includes("shell")),
  ).toEqual([]);
};

describe("data db: listing", () => {
  it("lists the databases with size and whether a WAL exists, from a real capture", async () => {
    const f = device([
      {
        match: lsCall(),
        respond: { stdoutFile: "captured/35/run-as-ls-l-databases.txt" },
      },
    ]);
    const { toon, data } = await both(f, [PKG]);
    expect(toon.exitCode).toBe(0);
    expect(toon.stdout).toContain(
      "count: 1 database\ndatabases[1]{name,size,wal}:\n  probe.db,4 KB,true\n",
    );
    expect(data.databases).toEqual([{ name: "probe.db", size: "4 KB", wal: true }]);
    expect(data.help).toEqual([
      "Run `adb-axi data db dev.probe 'SELECT name, sql FROM sqlite_master'` to read its schema",
    ]);
    expect(f.unmatched()).toEqual([]);
  });

  it("lists main files only, each with its own WAL flag", async () => {
    const f = device([
      {
        match: lsCall(),
        respond: {
          stdout: lsOutput({
            "notes.db": 98_304,
            "notes.db-wal": 4096,
            "notes.db-shm": 32_768,
            "cache.db": 1_500_000,
            "cache.db-journal": 0,
            "name with space.db": 20,
          }),
        },
      },
    ]);
    const { data } = await both(f, [PKG]);
    expect(data.databases).toEqual([
      { name: "notes.db", size: "96 KB", wal: true },
      { name: "cache.db", size: "1.4 MB", wal: false },
      { name: "name with space.db", size: "20 B", wal: false },
    ]);
    expect(data.help).toEqual([
      "Run `adb-axi data db dev.probe 'SELECT name, sql FROM sqlite_master' --db notes.db` to read its schema",
    ]);
  });

  it("says 0 databases, with exit 0, when the app has no databases directory", async () => {
    const f = device([
      {
        match: lsCall(),
        respond: { stderr: "ls: databases: No such file or directory\n", exit: 1 },
      },
    ]);
    const { toon, data } = await both(f, [PKG]);
    expect(toon.exitCode).toBe(0);
    expect(toon.stdout).toBe("count: 0 databases\ndatabases: []\n");
    expect(data).toEqual({ count: "0 databases", databases: [] });
  });

  it("fails with APP_NOT_DEBUGGABLE when run-as refuses the app (the real refusal text, on stderr)", async () => {
    const f = device([
      {
        match: lsCall(),
        respond: { stderr: "run-as: package not debuggable: dev.probe\n", exit: 1 },
      },
    ]);
    const { toon, data } = await both(f, [PKG]);
    expect(toon.exitCode).toBe(1);
    expect(data).toMatchObject({
      error: "dev.probe is not debuggable, so its private files cannot be read",
      code: "APP_NOT_DEBUGGABLE",
      detail: "run-as: package not debuggable: dev.probe",
    });
    expect(data.help).toHaveLength(1);
  });

  it("fails with APP_NOT_INSTALLED when run-as does not know the package", async () => {
    const f = device([
      {
        match: lsCall("dev.nope"),
        respond: { stderr: "run-as: unknown package: dev.nope\n", exit: 1 },
      },
    ]);
    const { toon, data } = await both(f, ["dev.nope"]);
    expect(toon.exitCode).toBe(1);
    expect(data).toMatchObject({ code: "APP_NOT_INSTALLED", error: "dev.nope is not installed" });
  });

  it("reports another failed listing as REMOTE_EXIT, never as no databases", async () => {
    const f = device([
      { match: lsCall(), respond: { stderr: "ls: databases: Permission denied\n", exit: 1 } },
    ]);
    const { toon, data } = await both(f, [PKG]);
    expect(toon.exitCode).toBe(1);
    expect(data).toMatchObject({ code: "REMOTE_EXIT", exit: 1 });
  });

  it("rejects a name that is not a package before touching the device", async () => {
    const f = device([]);
    const run = await runCli(["data", "db", "not a package"], f.env);
    expect(run.exitCode).toBe(2);
    expect(errorOf(run)).toMatchObject({ code: "VALIDATION_ERROR" });
    noDeviceReads(f);
  });

  it("refuses --db and --full without SQL instead of ignoring them", async () => {
    const f = device([]);
    for (const flag of [["--db", "a.db"], ["--full"]]) {
      const run = await runCli(["data", "db", PKG, ...flag], f.env);
      expect(run.exitCode).toBe(2);
      expect(errorOf(run)).toMatchObject({ code: "VALIDATION_ERROR" });
    }
    noDeviceReads(f);
  });
});

describe("data db: choosing the database", () => {
  const TWO = { "a.db": 4096, "b.db": 4096 };

  it("needs --db when the app has several, and lists them", async () => {
    const f = device([{ match: lsCall(), respond: { stdout: lsOutput(TWO) } }]);
    const { toon, data } = await both(f, [PKG, "SELECT 1"]);
    expect(toon.exitCode).toBe(2);
    expect(data).toMatchObject({
      error: "dev.probe has 2 databases; pick one with --db",
      code: "VALIDATION_ERROR",
      databases: ["a.db", "b.db"],
    });
    expect(f.calls().some((call) => call.argv.includes("exec-out"))).toBe(false);
  });

  it("fails with DB_NOT_FOUND, naming the databases that exist", async () => {
    const f = device([{ match: lsCall(), respond: { stdout: lsOutput(TWO) } }]);
    const { toon, data } = await both(f, [PKG, "SELECT 1", "--db", "missing.db"]);
    expect(toon.exitCode).toBe(1);
    expect(data).toMatchObject({
      error: "dev.probe has no database named missing.db",
      code: "DB_NOT_FOUND",
      databases: ["a.db", "b.db"],
    });
    expect(f.calls().some((call) => call.argv.includes("exec-out"))).toBe(false);
  });

  it("does not take a WAL or journal companion for a database", async () => {
    const f = device([
      { match: lsCall(), respond: { stdout: lsOutput({ "a.db": 4096, "a.db-wal": 0 }) } },
    ]);
    const { data } = await both(f, [PKG, "SELECT 1", "--db", "a.db-wal"]);
    expect(data).toMatchObject({ code: "DB_NOT_FOUND", databases: ["a.db"] });
  });

  it("fails with DB_NOT_FOUND when the app has no databases at all", async () => {
    const f = device([
      {
        match: lsCall(),
        respond: { stderr: "ls: databases: No such file or directory\n", exit: 1 },
      },
    ]);
    const { toon, data } = await both(f, [PKG, "SELECT 1"]);
    expect(toon.exitCode).toBe(1);
    expect(data).toMatchObject({
      error: "dev.probe has no databases",
      code: "DB_NOT_FOUND",
      databases: [],
    });
  });

  needsSqlite3("runs on the database named by --db when there are several", async () => {
    const a = makeDb("CREATE TABLE t(v); INSERT INTO t VALUES ('from a');", "a.db");
    const b = makeDb("CREATE TABLE t(v); INSERT INTO t VALUES ('from b');", "b.db");
    const f = deviceWith({ "a.db": a, "b.db": b });
    const { data } = await both(f, [PKG, "SELECT v FROM t", "--db", "b.db"]);
    expect(data.rows).toEqual([{ v: "from b" }]);
    expect(data.db).toMatch(/^b\.db \(no WAL, copied \d\d:\d\d:\d\d\)$/);
  });
});

describe("data db: reading", () => {
  needsSqlite3("returns the row that is only in the WAL of a real device capture", async () => {
    const f = deviceWith({
      "probe.db": join(CAPTURED, "exec-out-probe-db.bin"),
      "probe.db-wal": join(CAPTURED, "exec-out-probe-db-wal.bin"),
    });
    const { toon, data } = await both(f, [PKG, "SELECT id, text FROM notes ORDER BY id DESC"]);
    expect(toon.exitCode).toBe(0);
    expect(toon.stdout).toMatch(
      /^db: "probe\.db \(with WAL, copied \d\d:\d\d:\d\d\)"\nrows\[1\]\{id,text\}:\n {2}1,probe-1\n$/,
    );
    expect(data.rows).toEqual([{ id: 1, text: "probe-1" }]);
    expect(f.unmatched()).toEqual([]);
  });

  needsSqlite3("returns the newest row of a WAL database made with real sqlite3", async () => {
    const { db, wal } = await makeWalDb();
    // The premise: the main file alone does not have the newest row.
    const alone = join(scratchDir(), "alone.db");
    copyFileSync(db, alone);
    expect(execFileSync(SQLITE3 ?? "sqlite3", [alone, "SELECT title FROM note"]).toString()).toBe(
      "checkpointed\n",
    );

    const f = deviceWith({ "app.db": db, "app.db-wal": wal });
    const { data } = await both(f, [PKG, "SELECT id, title FROM note ORDER BY id DESC"]);
    expect(data.rows).toEqual([
      { id: 2, title: "only in the wal" },
      { id: 1, title: "checkpointed" },
    ]);
    expect(data.db).toMatch(/^app\.db \(with WAL, /);
    // Log first, then the main file; the index file is never copied.
    expect(
      f
        .calls()
        .filter((call) => call.argv.includes("exec-out"))
        .map((call) => call.argv.at(-1)),
    ).toEqual([
      "databases/app.db-wal",
      "databases/app.db",
      "databases/app.db-wal",
      "databases/app.db",
    ]);
  });

  needsSqlite3("leaves the copy's wal alone when the log is empty", async () => {
    const db = makeDb("CREATE TABLE t(v); INSERT INTO t VALUES (1);");
    const empty = join(scratchDir(), "empty-wal");
    writeFileSync(empty, "");
    const f = deviceWith({ "app.db": db, "app.db-wal": empty });
    const { data } = await both(f, [PKG, "SELECT v FROM t"]);
    expect(data.rows).toEqual([{ v: 1 }]);
    expect(data.db).toMatch(/^app\.db \(no WAL, /);
  });

  needsSqlite3("keeps every cell type and says 0 rows explicitly", async () => {
    const db = makeDb(
      "CREATE TABLE t(i, r, s, n); INSERT INTO t VALUES (7, 1.5, 'a,b \"q\"', NULL);",
    );
    const f = deviceWith({ "app.db": db });
    const one = await both(f, [PKG, "SELECT i, r, s, n FROM t"]);
    expect(one.data.rows).toEqual([{ i: 7, r: 1.5, s: 'a,b "q"', n: null }]);
    const none = await both(f, [PKG, "SELECT i FROM t WHERE i > 100"]);
    expect(none.toon.exitCode).toBe(0);
    expect(none.toon.stdout).toMatch(/\ncount: 0 rows\nrows: \[\]\n$/);
    expect(none.data).toMatchObject({ count: "0 rows", rows: [] });
  });

  needsSqlite3("keeps integers beyond 2^53 exact and same-named columns apart", async () => {
    const db = makeDb(
      "CREATE TABLE a(id); CREATE TABLE b(id); INSERT INTO a VALUES (9223372036854775807); INSERT INTO b VALUES (2);",
    );
    const f = deviceWith({ "app.db": db });
    const { data } = await both(f, [PKG, "SELECT a.id, b.id FROM a, b"]);
    expect(data.rows).toEqual([{ id: "9223372036854775807", id_2: 2 }]);
  });

  needsSqlite3(
    "reads SQL that starts with a comment or lacks its final semicolon, from stdin",
    async () => {
      const db = makeDb("CREATE TABLE t(v); INSERT INTO t VALUES (1), (2);");
      const f = deviceWith({ "app.db": db });
      for (const sql of [
        "/* count */ SELECT count(*) AS n FROM t",
        "SELECT count(*) AS n FROM t -- c",
      ]) {
        const { data } = await both(f, [PKG, sql]);
        expect(data.rows).toEqual([{ n: 2 }]);
      }
      const schema = await both(f, [PKG, "PRAGMA table_info(t)"]);
      expect(schema.data.rows).toEqual([
        { cid: 0, name: "v", type: "", notnull: 0, dflt_value: null, pk: 0 },
      ]);
    },
  );

  needsSqlite3("never leaves the copy on the host, and sends no host path to adb", async () => {
    const tmp = scratchDir();
    const db = makeDb("CREATE TABLE t(v);");
    const f = deviceWith({ "app.db": db }, { TMPDIR: tmp });
    await both(f, [PKG, "SELECT * FROM t"]);
    await runCli(["data", "db", PKG, "SELEC"], f.env);
    expect(readdirSync(tmp)).toEqual([]);
  });

  needsSqlite3("ignores the user's sqlite3 init file", async () => {
    const home = scratchDir();
    writeFileSync(join(home, ".sqliterc"), ".mode csv\n.headers off\n");
    const db = makeDb("CREATE TABLE t(v); INSERT INTO t VALUES (1);");
    const f = deviceWith({ "app.db": db }, { HOME: home });
    const { data } = await both(f, [PKG, "SELECT v FROM t"]);
    expect(data.rows).toEqual([{ v: 1 }]);
  });
});

describe("data db: errors", () => {
  needsSqlite3("carries sqlite3's message as SQL_ERROR", async () => {
    const db = makeDb("CREATE TABLE t(v);");
    const f = deviceWith({ "app.db": db });
    const { toon, data } = await both(f, [PKG, "SELECT nope FROM t"]);
    expect(toon.exitCode).toBe(1);
    expect(data).toMatchObject({
      error: "sqlite3 rejected the query on app.db: no such column: nope",
      code: "SQL_ERROR",
    });
    expect(String(data.detail)).toContain("no such column: nope");
    expect(Object.keys(data)).toEqual(["error", "code", "detail", "help"]);
  });

  needsSqlite3("refuses writefile in a SELECT without writing to the host", async () => {
    const path = join(scratchDir(), "leak.txt");
    const f = deviceWith({ "app.db": makeDb("CREATE TABLE t(v);") });
    const { toon, data } = await both(f, [PKG, `SELECT writefile('${path}', 'leak')`]);
    expect(toon.exitCode).toBe(1);
    expect(data.code).toBe("SQL_ERROR");
    expect(existsSync(path)).toBe(false);
  });

  needsSqlite3("fails with SQL_ERROR for a database sqlite3 cannot open", async () => {
    const corrupt = join(scratchDir(), "bad.db");
    writeFileSync(
      corrupt,
      Buffer.concat([Buffer.from("SQLite format 3\0"), Buffer.alloc(4096, 7)]),
    );
    const f = deviceWith({ "app.db": corrupt });
    const { toon, data } = await both(f, [PKG, "SELECT * FROM t"]);
    expect(toon.exitCode).toBe(1);
    expect(data.code).toBe("SQL_ERROR");
  });

  needsSqlite3(
    "refuses a write that gets past the statement check, with sqlite3's message",
    async () => {
      const db = makeDb("CREATE TABLE t(v); INSERT INTO t VALUES (1);");
      const f = deviceWith({ "app.db": db });
      const { toon, data } = await both(f, [PKG, "WITH x AS (SELECT 1) DELETE FROM t"]);
      expect(toon.exitCode).toBe(1);
      expect(data.code).toBe("SQL_ERROR");
      expect(String(data.error)).toMatch(/syntax error|readonly/i);
    },
  );

  it.each([
    ["INSERT INTO t VALUES (1)", "INSERT is not a read"],
    ["update t set v = 1", "UPDATE is not a read"],
    ["DELETE FROM t", "DELETE is not a read"],
    ["DROP TABLE t", "DROP is not a read"],
    ["CREATE TABLE x(v)", "CREATE is not a read"],
    ["VACUUM INTO '/tmp/adb-axi-leak.db'", "VACUUM is not a read"],
    ["ATTACH 'x.db' AS x", "ATTACH is not a read"],
    ["  /* c */ replace into t values (1)", "REPLACE is not a read"],
    [".shell touch /tmp/adb-axi-leak", "dot-commands are not accepted"],
    ["SELECT 1;\n.shell touch /tmp/adb-axi-leak", "2 statements"],
    ["SELECT 1; DELETE FROM t", "2 statements"],
    ["", "the SQL is empty"],
    ["/* only a comment */", "the SQL is empty"],
  ])("refuses %j before any device call", async (sql, message) => {
    const f = device([]);
    const run = await runCli(["data", "db", PKG, sql], f.env);
    expect(run.exitCode).toBe(2);
    expect(errorOf(run)).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(String(errorOf(run).error)).toContain(message);
    noDeviceReads(f);
    expect(existsSync("/tmp/adb-axi-leak")).toBe(false);
    expect(existsSync("/tmp/adb-axi-leak.db")).toBe(false);

    const json = await runCli(["data", "db", PKG, sql, "--json"], f.env);
    expect(json.exitCode).toBe(2);
    expect(JSON.parse(json.stdout)).toEqual(errorOf(run));
  });

  it("treats a ; or a leading . inside quotes and comments as text, not as a statement", async () => {
    const db = SQLITE3 === undefined ? "" : makeDb("CREATE TABLE t(v); INSERT INTO t VALUES (1);");
    if (SQLITE3 === undefined) return;
    const f = deviceWith({ "app.db": db });
    const { data } = await both(f, [
      PKG,
      "SELECT ';\n.shell x' AS s, \"a;b\" AS q /* ; .x */ FROM t",
    ]);
    expect(data.rows).toEqual([{ s: ";\n.shell x", q: "a;b" }]);
  });

  it("fails with INVALID_OUTPUT when the copied bytes are error text, as exec-out prints them (S1)", async () => {
    const f = device([
      { match: lsCall(), respond: { stdout: lsOutput({ "missing.db": 4096 }) } },
      {
        match: catCall("missing.db"),
        respond: { stdoutFile: "captured/35/exec-out-missing-db.bin" },
      },
    ]);
    const { toon, data } = await both(f, [PKG, "SELECT 1"]);
    expect(toon.exitCode).toBe(1);
    expect(data).toMatchObject({
      error: "the copy of databases/missing.db is not a SQLite database (53 bytes)",
      code: "INVALID_OUTPUT",
      detail: "cat: databases/missing.db: No such file or directory",
    });
  });

  it("fails with INVALID_OUTPUT for an empty copy, and for text where a WAL should be", async () => {
    const empty = device([
      { match: lsCall(), respond: { stdout: lsOutput({ "a.db": 0 }) } },
      { match: catCall("a.db"), respond: {} },
    ]);
    const first = await both(empty, [PKG, "SELECT 1"]);
    expect(first.data).toMatchObject({
      error: "the copy of databases/a.db is not a SQLite database (0 bytes)",
      code: "INVALID_OUTPUT",
    });
    expect(first.data).not.toHaveProperty("detail");

    const wal = device([
      { match: lsCall(), respond: { stdout: lsOutput({ "a.db": 4096, "a.db-wal": 4096 }) } },
      {
        match: catCall("a.db-wal"),
        respond: { stdoutFile: "captured/35/exec-out-missing-db.bin" },
      },
    ]);
    const second = await both(wal, [PKG, "SELECT 1"]);
    expect(second.data).toMatchObject({
      error: "the copy of databases/a.db-wal is not a WAL file (53 bytes)",
      code: "INVALID_OUTPUT",
    });
    expect(wal.calls().some((call) => call.argv.at(-1) === "databases/a.db")).toBe(false);
  });

  it("does not print binary garbage as detail", async () => {
    const bin = join(scratchDir(), "garbage.bin");
    writeFileSync(bin, Buffer.from([0, 1, 2, 3, 255, 254]));
    const f = device([
      { match: lsCall(), respond: { stdout: lsOutput({ "a.db": 6 }) } },
      { match: catCall("a.db"), respond: { stdoutFile: bin } },
    ]);
    const run = await runCli(["data", "db", PKG, "SELECT 1", "--json"], f.env);
    expect(JSON.parse(run.stdout)).toMatchObject({ code: "INVALID_OUTPUT" });
    expect(JSON.parse(run.stdout)).not.toHaveProperty("detail");
  });

  it("fails with APP_NOT_DEBUGGABLE when the refusal arrives as the bytes (S1, real capture)", async () => {
    const f = device([
      { match: lsCall(), respond: { stdout: lsOutput({ "probe.db": 4096 }) } },
      {
        match: catCall("probe.db"),
        respond: { stdoutFile: "captured/35/exec-out-run-as-release.bin" },
      },
    ]);
    const { toon, data } = await both(f, [PKG, "SELECT 1"]);
    expect(toon.exitCode).toBe(1);
    expect(data).toMatchObject({
      code: "APP_NOT_DEBUGGABLE",
      detail: "run-as: package not debuggable: dev.probe",
    });
  });

  it("fails with SQLITE_NOT_FOUND, naming where it looked, when no host sqlite3 exists", async () => {
    const home = scratchDir();
    const f = device([], { HOME: home, ANDROID_HOME: undefined, ANDROID_SDK_ROOT: undefined });
    // PATH holds only the fake adb, so there is no sqlite3 anywhere.
    const env = { ...f.env, PATH: f.binDir };
    const run = await runCli(["data", "db", PKG, "SELECT 1"], env);
    expect(run.exitCode).toBe(1);
    const error = errorOf(run);
    expect(error).toMatchObject({ code: "SQLITE_NOT_FOUND" });
    expect(error.searched).toEqual([
      "PATH (1 directories)",
      "$ANDROID_HOME/platform-tools ($ANDROID_HOME is not set)",
      "$ANDROID_SDK_ROOT/platform-tools ($ANDROID_SDK_ROOT is not set)",
      join(home, "Library", "Android", "sdk", "platform-tools", "sqlite3"),
    ]);
    noDeviceReads(f);
  });

  needsSqlite3("finds sqlite3 in the SDK like adb, when it is not on PATH", async () => {
    const sdk = scratchDir();
    mkdirSync(join(sdk, "platform-tools"));
    const wrapper = join(sdk, "platform-tools", "sqlite3");
    writeFileSync(wrapper, `#!/bin/sh\nexec '${SQLITE3}' "$@"\n`);
    chmodSync(wrapper, 0o755);
    const db = makeDb("CREATE TABLE t(v); INSERT INTO t VALUES (5);");
    const f = deviceWith({ "app.db": db }, { ANDROID_HOME: sdk });
    const run = await runCli(["data", "db", PKG, "SELECT v FROM t", "--json"], {
      ...f.env,
      PATH: f.binDir,
    });
    expect(run.exitCode).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ rows: [{ v: 5 }] });
  });
});

describe("data db: deadlines", () => {
  const TIMEOUT_MS = 1000;

  it.each([
    ["the listing", "listing the databases of dev.probe", lsCall()],
    ["the copy", "copying databases/app.db of dev.probe", catCall("app.db")],
  ])(
    "kills a hung adb call during %s at --timeout and names the step",
    async (_name, step, call) => {
      const f = device([
        call.includes("exec-out")
          ? { match: lsCall(), respond: { stdout: lsOutput({ "app.db": 4096 }) } }
          : { match: ["-s", SERIAL, "shell", "unused"], respond: {} },
        { match: call, respond: { hang: true } satisfies Response },
      ]);
      const run = await runCli(["data", "db", PKG, "SELECT 1", "--timeout", "1s"], f.env);
      expect(run.exitCode).toBe(1);
      expect(errorOf(run)).toMatchObject({ code: "TIMEOUT", step });
      expect(run.durationMs).toBeLessThan(TIMEOUT_MS + 5_000 + MARGIN_MS);
      for (const hung of f.calls().filter((c) => c.end === null)) {
        expect(isProcessAlive(hung.pid)).toBe(false);
      }
    },
  );

  needsSqlite3("gives every adb call a deadline: the whole command ends at --timeout", async () => {
    const db = makeDb("CREATE TABLE t(v);");
    const f = device([
      { match: lsCall(), respond: { stdout: lsOutput({ "app.db": statSync(db).size }) } },
      { match: catCall("app.db"), respond: { stdoutFile: db, delayMs: 5_000 } },
    ]);
    const run = await runCli(["data", "db", PKG, "SELECT 1", "--timeout", "1s"], f.env);
    expect(run.exitCode).toBe(1);
    expect(errorOf(run)).toMatchObject({ code: "TIMEOUT" });
    expect(run.durationMs).toBeLessThan(TIMEOUT_MS + 4_000 + MARGIN_MS);
  });

  needsSqlite3("kills a sqlite3 query that outlives the deadline", async () => {
    const db = makeDb("CREATE TABLE t(v);");
    const f = deviceWith({ "app.db": db });
    // A recursive query that never finishes.
    const sql =
      "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT max(x) FROM c";
    const run = await runCli(["data", "db", PKG, sql, "--timeout", "2s"], f.env);
    expect(run.exitCode).toBe(1);
    expect(errorOf(run)).toMatchObject({
      code: "TIMEOUT",
      step: "querying the copy of app.db",
      error: "querying the copy of app.db did not finish before the 2 s deadline",
    });
    expect(run.durationMs).toBeLessThan(2000 + 4_000 + MARGIN_MS);
  });
});

describe("data db: row cap and --full", () => {
  const MANY = (n: number): string =>
    `CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT); WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ${n}) INSERT INTO t(v) SELECT 'row ' || x FROM c;`;

  needsSqlite3("shows 50 rows of a larger result, says so, and points at --full", async () => {
    const f = deviceWith({ "app.db": makeDb(MANY(120)) });
    const { toon, data } = await both(f, [PKG, "SELECT id, v FROM t ORDER BY id"]);
    expect(toon.exitCode).toBe(0);
    expect(data.rows).toHaveLength(50);
    expect((data.rows as { id: number }[]).at(-1)).toEqual({ id: 50, v: "row 50" });
    expect(data.shown).toBe("50 of 120 rows");
    expect(data.help).toEqual([
      "Run the same command with `--full` to write all 120 rows to a file",
    ]);
    expect(data).not.toHaveProperty("full");
    expect(toon.stdout).toContain("rows[50]{id,v}:");
  });

  needsSqlite3("shows exactly 50 rows with no shown line and no --full help", async () => {
    const f = deviceWith({ "app.db": makeDb(MANY(50)) });
    const { data } = await both(f, [PKG, "SELECT id FROM t"]);
    expect(data.rows).toHaveLength(50);
    expect(data).not.toHaveProperty("shown");
    expect(data).not.toHaveProperty("help");
  });

  needsSqlite3("writes every row to a file with --full, with default file attributes", async () => {
    const f = deviceWith({ "app.db": makeDb(MANY(120)) });
    const toon = await runCli(
      ["data", "db", PKG, "SELECT id, v FROM t ORDER BY id", "--full"],
      f.env,
    );
    expect(toon.exitCode).toBe(0);
    const data = decode(toon.stdout.trimEnd()) as Record<string, unknown>;
    expect(data.rows).toHaveLength(50);
    expect(data.shown).toBe("50 of 120 rows");
    expect(data).not.toHaveProperty("help");

    const path = data.full as string;
    expect(path.startsWith(join(f.home, "out") + "/db-app.db-")).toBe(true);
    const file = decode(readFileSync(path, "utf8").trimEnd()) as { rows: { id: number }[] };
    expect(file.rows).toHaveLength(120);
    expect(file.rows.at(-1)).toEqual({ id: 120, v: "row 120" });
    // Default attributes: what a plain create gives here, not a 0600 temp file or a forced 0644.
    const plain = join(scratchDir(), "plain");
    writeFileSync(plain, "");
    expect(statSync(path).mode & 0o777).toBe(statSync(plain).mode & 0o777);
    const plainDir = join(scratchDir(), "dir");
    mkdirSync(plainDir);
    expect(statSync(dirname(path)).mode & 0o777).toBe(statSync(plainDir).mode & 0o777);

    const json = await runCli(
      ["data", "db", PKG, "SELECT id, v FROM t ORDER BY id", "--full", "--json"],
      f.env,
    );
    const jsonData = JSON.parse(json.stdout) as Record<string, unknown>;
    expect(normalize(jsonData)).toEqual(normalize(data));
    const jsonFile = JSON.parse(readFileSync(jsonData.full as string, "utf8")) as {
      rows: unknown[];
    };
    expect(jsonFile.rows).toHaveLength(120);
    expect(jsonData.full).not.toBe(path);
  });

  needsSqlite3("writes no file for --full when nothing was cut", async () => {
    const f = deviceWith({ "app.db": makeDb(MANY(3)) });
    const { data } = await both(f, [PKG, "SELECT id FROM t", "--full"]);
    expect(data.rows).toHaveLength(3);
    expect(data).not.toHaveProperty("full");
    expect(existsSync(join(f.home, "out"))).toBe(false);
  });

  needsSqlite3("cuts a long cell and keeps it whole in the --full file", async () => {
    const long = "x".repeat(600);
    const f = deviceWith({
      "app.db": makeDb(`CREATE TABLE t(v); INSERT INTO t VALUES ('${long}');`),
    });
    const plain = await both(f, [PKG, "SELECT v FROM t"]);
    expect(plain.data.rows).toEqual([{ v: `${"x".repeat(500)}... (truncated, 600 chars total)` }]);
    expect(plain.data).not.toHaveProperty("shown");
    expect(plain.data.help).toEqual([
      "Run the same command with `--full` to write the long cells to a file",
    ]);

    const full = await runCli(["data", "db", PKG, "SELECT v FROM t", "--full", "--json"], f.env);
    const data = JSON.parse(full.stdout) as Record<string, unknown>;
    const file = JSON.parse(readFileSync(data.full as string, "utf8")) as { rows: { v: string }[] };
    expect(file.rows[0]?.v).toBe(long);
  });
});

describe("data db: registration", () => {
  it("documents the 64 MB query result limit in command help", async () => {
    const f = device([]);
    const run = await runCli(["data", "db", "--help"], f.env);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("64 MB result limit");
  });

  it("is shipped: listed in `data --help` and in the top-level help", async () => {
    const f = device([]);
    const group = await runCli(["data", "--help"], f.env);
    expect(group.stdout).toContain("adb-axi data db");
    const top = await runCli(["--help"], f.env);
    expect(top.stdout).toContain("data");
    expect(f.calls()).toEqual([]);
  });
});
