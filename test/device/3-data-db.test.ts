import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { sharedWithToon } from "../helpers/json.js";
import { Axi, DEBUG_APK, PKG, RELEASE_APK, probeState } from "./support.js";

const axi = new Axi(import.meta.filename);

describe("data db", () => {
  test("returns a row that is still only in the WAL", async () => {
    await axi.ok(["app", "install", DEBUG_APK, "--clean-data"]);
    await axi.ok(["app", "start", PKG, "--fresh"]);
    await axi.mark("before-write");
    await axi.probe("write");
    await axi.waitLog("event=write .*rows=1 ", "before-write");

    // The row's text is in the WAL and nowhere in the main database file yet.
    const files = await axi.ok([
      "shell",
      `run-as ${PKG} grep -c probe-1 databases/probe.db databases/probe.db-wal`,
    ]);
    expect(String(files.stdout).split("\n")).toEqual([
      "databases/probe.db:0",
      "databases/probe.db-wal:1",
    ]);

    const sql = "SELECT id, text FROM notes ORDER BY id DESC";
    const query = await axi.ok(["data", "db", PKG, sql]);
    expect(query.rows).toEqual([{ id: 1, text: "probe-1" }]);
    expect(query.db).toMatch(/^probe\.db \(with WAL, copied \d\d:\d\d:\d\d\)$/);
    const text = await axi.text(["data", "db", PKG, sql]);
    expect(text.stdout).toMatch(
      /^db: "probe\.db \(with WAL, copied \d\d:\d\d:\d\d\)"\nrows\[1\]\{id,text\}:\n {2}1,probe-1\n$/,
    );
    expect(text.data.rows).toEqual(query.rows);
  });

  test("a release build is APP_NOT_DEBUGGABLE", async () => {
    await axi.ok(["app", "install", RELEASE_APK]);
    const run = await axi.run(["data", "db", PKG]);
    expect(run.exitCode).toBe(1);
    expect(run.json).toMatchObject({
      error: "dev.probe is not debuggable, so its private files cannot be read",
      code: "APP_NOT_DEBUGGABLE",
      detail: "run-as: package not debuggable: dev.probe",
    });
    expect(run.json.help).toHaveLength(1);
    expect((await axi.text(["data", "db", PKG], 120_000, 1)).data).toEqual(run.json);
  });
});

/** A device-shell single-quoted word. */
function quoted(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/** Run one statement on an app database through the probe, and wait for its oracle line. */
async function sql(db: string, statement: string, wal = false): Promise<void> {
  const mark = `sql-${Date.now()}`;
  await axi.mark(mark);
  await axi.probe(
    "sql",
    `--es db ${db} --es stmt ${quoted(statement)}${wal ? " --ez wal true" : ""}`,
  );
  const line = await axi.waitLog(`event=sql db=${db.replaceAll(".", "[.]")} `, mark);
  expect(line).toMatch(/ ok pid=/);
}

async function writeAppFile(name: string, text: string): Promise<void> {
  const mark = `file-${Date.now()}`;
  await axi.mark(mark);
  await axi.probe("file", `--es name ${name} --es where databases --es text ${quoted(text)}`);
  expect(
    probeState(await axi.waitLog(`event=file name=${name.replaceAll(".", "[.]")} `, mark)).name,
  ).toBe(name);
}

/** The app's databases folder as the app itself sees it: file name to size in bytes. */
async function databaseFiles(): Promise<Map<string, number>> {
  const listing = await axi.sh(`run-as ${PKG} sh -c 'cd databases && stat -c "%n %s" *'`);
  return new Map(
    listing
      .trim()
      .split("\n")
      .map((line) => line.split(" "))
      .map(([name, size]) => [name ?? "", Number(size)]),
  );
}

function bytesOf(size: string): number {
  const [value, unit] = size.split(" ");
  return Number(value) * ({ B: 1, KB: 1024, MB: 1024 * 1024 }[unit ?? ""] ?? NaN);
}

async function fresh(): Promise<void> {
  await axi.ok(["app", "install", DEBUG_APK, "--clean-data"]);
  await axi.ok(["app", "start", PKG]);
}

describe("data db on real app databases", () => {
  test("no databases yet, then several: the listing, --db, companions and a missing name", async () => {
    const missing = `${PKG}.missing`;
    expect(await axi.sh(`pm path ${missing} || true`)).toBe("");
    expect(await axi.fails(["data", "db", missing], "APP_NOT_INSTALLED")).toMatchObject({
      error: `${missing} is not installed`,
    });
    await axi.ok(["app", "install", DEBUG_APK, "--clean-data"]);
    expect(await axi.sh(`run-as ${PKG} ls databases 2>&1 || true`)).toMatch(/No such file/);
    const empty = await axi.ok(["data", "db", PKG]);
    expect(sharedWithToon(empty)).toEqual({ count: "0 databases", databases: [] });
    expect((await axi.text(["data", "db", PKG])).data).toEqual(empty);
    expect(await axi.fails(["data", "db", PKG, "SELECT 1"], "DB_NOT_FOUND")).toEqual({
      error: `${PKG} has no databases`,
      code: "DB_NOT_FOUND",
      databases: [],
      help: ["Run the app so it creates its database, then run the command again"],
    });

    await axi.ok(["app", "start", PKG]);
    await sql("extra.db", "CREATE TABLE t(v)");
    await sql("extra.db", "INSERT INTO t VALUES ('extra')");
    await sql("wal.db", "CREATE TABLE w(v)", true);
    await sql("wal.db", "INSERT INTO w VALUES ('wal')", true);
    await axi.mark("room");
    await axi.probe("write");
    await axi.waitLog("event=write ", "room");
    const files = await databaseFiles();
    const names = ["extra.db", "probe.db", "wal.db"];
    expect([...files.keys()].filter((name) => !names.includes(name)).sort()).toEqual(
      expect.arrayContaining(["probe.db-wal", "wal.db-wal"]),
    );

    const listing = await axi.ok(["data", "db", PKG]);
    expect(listing.count).toBe("3 databases");
    const listed = listing.databases as { name: string; size: string; wal: boolean }[];
    expect(listed.map((db) => db.name)).toEqual(names);
    for (const db of listed) {
      expect(db.wal).toBe(files.has(`${db.name}-wal`));
      expect(Math.abs(bytesOf(db.size) - (files.get(db.name) ?? -1))).toBeLessThanOrEqual(
        db.size.endsWith(" B") ? 0 : 52,
      );
    }
    expect((await axi.text(["data", "db", PKG])).data).toEqual(sharedWithToon(listing));

    const ambiguous = await axi.run(["data", "db", PKG, "SELECT 1"]);
    expect(ambiguous.exitCode).toBe(2);
    expect(ambiguous.json).toEqual({
      error: `${PKG} has 3 databases; pick one with --db`,
      code: "VALIDATION_ERROR",
      databases: names,
      help: [
        `Run \`adb-axi data db ${PKG} <sql> --db <name> --device ${axi.serial}\` with one of the names above`,
      ],
    });
    expect(
      await axi.fails(["data", "db", PKG, "SELECT 1", "--db", "nope.db"], "DB_NOT_FOUND"),
    ).toEqual({
      error: `${PKG} has no database named nope.db`,
      code: "DB_NOT_FOUND",
      databases: names,
      help: [`Run \`adb-axi data db ${PKG} --device ${axi.serial}\` to list its databases`],
    });
    for (const companion of ["extra.db-journal", "wal.db-wal"]) {
      if (!files.has(companion)) continue;
      expect((await axi.run(["data", "db", PKG, "SELECT 1", "--db", companion])).json.code).toBe(
        "DB_NOT_FOUND",
      );
    }
    const extra = await axi.ok(["data", "db", PKG, "SELECT v FROM t", "--db", "extra.db"]);
    expect(extra.rows).toEqual([{ v: "extra" }]);
    expect(extra.db).toMatch(/^extra\.db \(no WAL, copied \d\d:\d\d:\d\d\)$/);
    const wal = await axi.ok(["data", "db", PKG, "SELECT v FROM w", "--db", "wal.db"]);
    expect(wal.rows).toEqual([{ v: "wal" }]);
    expect(wal.db).toMatch(/^wal\.db \(with WAL, copied /);
  });

  test("a lock file is not a database, and a file that is not SQLite is SQL_ERROR", async () => {
    await fresh();
    await writeAppFile("probe.db.lck", "");
    expect((await databaseFiles()).has("probe.db.lck")).toBe(true);
    const listing = await axi.ok(["data", "db", PKG]);
    expect((listing.databases as { name: string }[]).map((db) => db.name)).toEqual(["probe.db"]);
    expect((await axi.ok(["data", "db", PKG, "SELECT count(*) AS n FROM notes"])).rows).toEqual([
      { n: 0 },
    ]);
    await writeAppFile("garbage.db", "this is not a database");
    expect(
      await axi.fails(["data", "db", PKG, "SELECT 1", "--db", "garbage.db"], "INVALID_OUTPUT"),
    ).toEqual({
      error: "the copy of databases/garbage.db is not a SQLite database (22 bytes)",
      code: "INVALID_OUTPUT",
      step: `copying databases/garbage.db of ${PKG}`,
      detail: "this is not a database",
      help: [
        `Run \`adb-axi data db ${PKG} --device ${axi.serial}\` to check the file is still there`,
      ],
    });
    await axi.sh(
      `run-as ${PKG} sh -c 'printf "SQLite format 3\\000" > databases/bad.db && head -c 4096 /dev/zero | tr "\\000" "\\007" >> databases/bad.db'`,
    );
    expect((await databaseFiles()).get("bad.db")).toBe(16 + 4096);
    const bad = await axi.fails(
      ["data", "db", PKG, "SELECT * FROM t", "--db", "bad.db"],
      "SQL_ERROR",
    );
    expect(String(bad.error)).toMatch(/^SQLite rejected the query on bad\.db: /);
  });

  test("every cell type, exact big integers, same-named columns, comments and 0 rows", async () => {
    await fresh();
    await sql("cells.db", "CREATE TABLE t(i, r, s, n)");
    await sql("cells.db", `INSERT INTO t VALUES (7, 1.5, 'a,b "q"', NULL)`);
    await sql("cells.db", "CREATE TABLE a(id)");
    await sql("cells.db", "CREATE TABLE b(id)");
    await sql("cells.db", "INSERT INTO a VALUES (9223372036854775807)");
    await sql("cells.db", "INSERT INTO b VALUES (2)");
    const query = (statement: string): Promise<Record<string, unknown>> =>
      axi.ok(["data", "db", PKG, statement, "--db", "cells.db"]);
    const cells = await query("SELECT i, r, s, n, X'C3A9' AS utf8, X'FF' AS invalid FROM t");
    expect(cells.rows).toEqual([{ i: 7, r: 1.5, s: 'a,b "q"', n: null, utf8: "é", invalid: "ÿ" }]);
    expect(
      (await axi.text(["data", "db", PKG, "SELECT i, r, s, n FROM t", "--db", "cells.db"])).data
        .rows,
    ).toEqual([{ i: 7, r: 1.5, s: 'a,b "q"', n: null }]);
    const none = await axi.text([
      "data",
      "db",
      PKG,
      "SELECT i FROM t WHERE i > 100",
      "--db",
      "cells.db",
    ]);
    expect(none.stdout).toMatch(/\ncount: 0 rows\nrows: \[\]\n$/);
    expect((await query("SELECT a.id, b.id FROM a, b")).rows).toEqual([
      { id: "9223372036854775807", id_2: 2 },
    ]);
    for (const statement of [
      "/* count */ SELECT count(*) AS n FROM t",
      "SELECT count(*) AS n FROM t -- c",
    ]) {
      expect((await query(statement)).rows).toEqual([{ n: 1 }]);
    }
    expect((await query("PRAGMA table_info(b)")).rows).toEqual([
      { cid: 0, name: "id", type: "", notnull: 0, dflt_value: null, pk: 0 },
    ]);
  });

  test("SQLite's own errors, a write past the statement check, and a query past --timeout", async () => {
    await fresh();
    await sql("cells.db", "CREATE TABLE t(v)");
    await sql("cells.db", "INSERT INTO t VALUES (1)");
    const missing = await axi.fails(
      ["data", "db", PKG, "SELECT nope FROM t", "--db", "cells.db"],
      "SQL_ERROR",
    );
    expect(Object.keys(missing)).toEqual(["error", "code", "detail", "help"]);
    expect(missing.error).toBe("SQLite rejected the query on cells.db: no such column: nope");
    const write = await axi.fails(
      ["data", "db", PKG, "WITH x AS (SELECT 1) DELETE FROM t", "--db", "cells.db"],
      "SQL_ERROR",
    );
    expect(String(write.error)).toMatch(/syntax error|read-?only/i);
    expect((await axi.ok(["data", "db", PKG, "SELECT v FROM t", "--db", "cells.db"])).rows).toEqual(
      [{ v: 1 }],
    );
    const forever =
      "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT max(x) FROM c";
    const run = await axi.run(["data", "db", PKG, forever, "--db", "cells.db", "--timeout", "2s"]);
    expect(run.exitCode).toBe(1);
    expect(run.json).toMatchObject({
      code: "TIMEOUT",
      step: "querying the copy of cells.db",
      error: "querying the copy of cells.db did not finish before the 2 s deadline",
    });
    expect(run.durationMs).toBeLessThan(2_000 + 4_000);
  });

  test("50 rows of 120 with --full writing them all, exactly 50 with no cut, and a long cell", async () => {
    await fresh();
    await sql("many.db", "CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)");
    await sql(
      "many.db",
      "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 120) INSERT INTO t(v) SELECT 'row ' || x FROM c",
    );
    await sql("many.db", "CREATE TABLE l(v)");
    await sql("many.db", `INSERT INTO l VALUES ('${"x".repeat(600)}')`);
    const ordered = "SELECT id, v FROM t ORDER BY id";
    const cut = await axi.text(["data", "db", PKG, ordered, "--db", "many.db"]);
    expect(cut.stdout).toContain("rows[50]{id,v}:");
    expect((cut.data.rows as unknown[]).at(-1)).toEqual({ id: 50, v: "row 50" });
    expect(cut.data).toMatchObject({
      shown: "50 of 120 rows",
      help: ["Run the same command with `--full` to write all 120 rows to a file"],
    });
    expect(cut.data).not.toHaveProperty("full");

    const full = await axi.ok(["data", "db", PKG, ordered, "--db", "many.db", "--full"]);
    expect(full.shown).toBe("50 of 120 rows");
    expect(full).not.toHaveProperty("help");
    const path = String(full.full);
    expect(path.startsWith(join(axi.stateHome, "out") + "/db-many.db-")).toBe(true);
    const file = JSON.parse(readFileSync(path, "utf8")) as { rows: { id: number; v: string }[] };
    expect(file.rows).toHaveLength(120);
    expect(file.rows.at(-1)).toEqual({ id: 120, v: "row 120" });
    const scratch = mkdtempSync(join(tmpdir(), "adb-axi-device-mode-"));
    try {
      writeFileSync(join(scratch, "plain"), "");
      mkdirSync(join(scratch, "dir"));
      expect(statSync(path).mode & 0o777).toBe(statSync(join(scratch, "plain")).mode & 0o777);
      expect(statSync(dirname(path)).mode & 0o777).toBe(
        statSync(join(scratch, "dir")).mode & 0o777,
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }

    const fifty = await axi.ok([
      "data",
      "db",
      PKG,
      "SELECT id FROM t LIMIT 50",
      "--db",
      "many.db",
      "--full",
    ]);
    expect(fifty.rows).toHaveLength(50);
    for (const key of ["shown", "help", "full"]) expect(fifty).not.toHaveProperty(key);

    const long = await axi.ok(["data", "db", PKG, "SELECT v FROM l", "--db", "many.db"]);
    expect(long.rows).toEqual([{ v: `${"x".repeat(500)}... (truncated, 600 chars total)` }]);
    expect(long.help).toEqual([
      "Run the same command with `--full` to write the long cells to a file",
    ]);
    const longFull = await axi.ok([
      "data",
      "db",
      PKG,
      "SELECT v FROM l",
      "--db",
      "many.db",
      "--full",
    ]);
    const longFile = JSON.parse(readFileSync(String(longFull.full), "utf8")) as {
      rows: { v: string }[];
    };
    expect(longFile.rows[0]?.v).toBe("x".repeat(600));
  });
});
