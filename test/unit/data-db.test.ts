import { mkdtempSync, readdirSync, rmSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { formatSize } from "../../src/commands/data/db.js";
import { readRows, runQuery } from "../../src/commands/data/sqlite-query.js";
import { Deadline } from "../../src/core/deadline.js";
import { assertReadOnlySql, statementHeads } from "../../src/commands/data/sql-guard.js";

describe("statementHeads", () => {
  it("finds the first word of each statement, skipping comments and quoted text", () => {
    expect(statementHeads("select 1; /* x; y */ -- z; w\n  Pragma foo; ")).toEqual([
      "select",
      "Pragma",
    ]);
    expect(statementHeads(`SELECT ';', "a;b", [c;d], \`e;f\`, 'it''s;'`)).toEqual(["SELECT"]);
    expect(statementHeads(";;  ;")).toEqual([]);
    expect(statementHeads(".tables")).toEqual(["."]);
    expect(statementHeads("SELECT 'unterminated; DELETE")).toEqual(["SELECT"]);
  });
});

describe("assertReadOnlySql", () => {
  it.each([
    "SELECT 1",
    "with x as (select 1) select * from x;",
    "PRAGMA table_info(t)",
    "values (1)",
  ])("accepts %j", (sql) => {
    expect(() => {
      assertReadOnlySql(sql);
    }).not.toThrow();
  });
  it.each(["INSERT INTO t VALUES (1)", "VACUUM INTO 'x'", ".shell ls", "SELECT 1; SELECT 2", ""])(
    "refuses %j",
    (sql) => {
      expect(() => {
        assertReadOnlySql(sql);
      }).toThrow(expect.objectContaining({ code: "VALIDATION_ERROR" }));
    },
  );
});

describe("readRows", () => {
  it("reads rows in column order and a column line alone as no rows", () => {
    expect(readRows("app.db", '["b","a"]\n')).toEqual([]);
    expect(readRows("app.db", '["b","a"]\n[1,"x"]\n[2,null]\n')).toEqual([
      { b: 1, a: "x" },
      { b: 2, a: null },
    ]);
    expect(Object.keys(readRows("app.db", '["b","a"]\n[1,2]\n')[0] ?? {})).toEqual(["b", "a"]);
  });

  it("keeps big integers exact, renames repeated columns, and keeps __proto__ a column", () => {
    const [row] = readRows(
      "app.db",
      '["id","id","id","__proto__","f"]\n["9007199254740993",2,3,4,1500]\n',
    );
    expect(Object.keys(row ?? {})).toEqual(["id", "id_2", "id_3", "__proto__", "f"]);
    expect(row).toMatchObject({ id: "9007199254740993", id_2: 2, id_3: 3, f: 1500 });
    expect(Object.getOwnPropertyDescriptor(row, "__proto__")?.value).toBe(4);
  });

  it.each(["", '["a"]\n[1', '{"a":1}', '["a"]\n{"a":1}', '["a"]\n[1,2]', "[1]"])(
    "rejects malformed %j as INVALID_OUTPUT",
    (text) => {
      expect(() => readRows("app.db", text)).toThrow(
        expect.objectContaining({ code: "INVALID_OUTPUT" }),
      );
    },
  );
});

describe("runQuery", () => {
  it("confines a large sort's spill files to the query directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "adb-axi-query-test-"));
    const database = join(dir, "copy.db");
    new DatabaseSync(database).close();
    const seen = new Set<string>();
    // Install before starting the child: SQLite immediately unlinks spill files,
    // so discovering this directory via a parent watcher races with their creation.
    const watcher = watch(dir, (_event, filename) => {
      if (filename !== null) seen.add(filename);
    });
    try {
      const rows = await runQuery({
        database,
        workDir: dir,
        env: process.env,
        deadline: new Deadline(20_000),
        step: "sorting the copy of app.db",
        label: "app.db",
        sql:
          "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<65536) " +
          "SELECT count(*) AS n FROM (SELECT printf('%01024d',x) AS v FROM c ORDER BY v DESC)",
      });
      // The recursive sequence has exactly 65,536 rows; the wide sort must spill.
      expect(rows).toEqual([{ n: 65536 }]);
      expect([...seen].some((name) => name.startsWith("etilqs_"))).toBe(true);
      expect(readdirSync(dir)).toEqual(["copy.db"]);
    } finally {
      watcher.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses an ATTACH of another host database, even past the statement check", async () => {
    const dir = mkdtempSync(join(tmpdir(), "adb-axi-query-test-"));
    try {
      const host = join(dir, "host.db");
      const other = new DatabaseSync(host);
      other.exec("CREATE TABLE secret(v); INSERT INTO secret VALUES ('host sentinel');");
      other.close();
      const copy = join(dir, "copy.db");
      new DatabaseSync(copy).close();
      const request = {
        database: copy,
        workDir: dir,
        env: process.env,
        deadline: new Deadline(20_000),
        step: "querying the copy of app.db",
        label: "app.db",
      };
      await expect(runQuery({ ...request, sql: `ATTACH '${host}' AS h` })).rejects.toMatchObject({
        code: "SQL_ERROR",
        message: expect.stringContaining("not authorized") as unknown,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("formatSize", () => {
  it("prints bytes, KB and MB", () => {
    expect([0, 20, 4096, 45_352, 1_500_000, 5_242_880].map(formatSize)).toEqual([
      "0 B",
      "20 B",
      "4 KB",
      "44.3 KB",
      "1.4 MB",
      "5 MB",
    ]);
  });
});
