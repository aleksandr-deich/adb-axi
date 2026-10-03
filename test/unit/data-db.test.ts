import { describe, expect, it } from "vitest";
import { formatSize } from "../../src/commands/data/db.js";
import { parseSqliteJson, SqliteJsonError } from "../../src/commands/data/sqlite-json.js";
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

describe("parseSqliteJson", () => {
  it("reads rows in column order and nothing as no rows", () => {
    expect(parseSqliteJson("")).toEqual([]);
    expect(parseSqliteJson("[]")).toEqual([]);
    expect(parseSqliteJson('[{"b":1,"a":"x"},\n{"b":2,"a":null}]\n')).toEqual([
      { b: 1, a: "x" },
      { b: 2, a: null },
    ]);
    expect(Object.keys(parseSqliteJson('[{"b":1,"a":2}]')[0] ?? {})).toEqual(["b", "a"]);
  });

  it("decodes string escapes", () => {
    expect(parseSqliteJson('[{"s":"a\\"b\\\\c\\n\\u00e9\\t"}]')).toEqual([{ s: 'a"b\\c\né\t' }]);
  });

  it("keeps big integers exact, renames repeated columns, and keeps __proto__ a column", () => {
    const [row] = parseSqliteJson(
      '[{"id":9007199254740993,"id":2,"id":3,"__proto__":4,"f":1.5e3}]',
    );
    expect(Object.keys(row ?? {})).toEqual(["id", "id_2", "id_3", "__proto__", "f"]);
    expect(row).toMatchObject({ id: "9007199254740993", id_2: 2, id_3: 3, f: 1500 });
    expect(Object.getOwnPropertyDescriptor(row, "__proto__")?.value).toBe(4);
  });

  it("keeps a value that is not JSON as the text sqlite3 printed", () => {
    expect(parseSqliteJson('[{"x":Inf}]')).toEqual([{ x: "Inf" }]);
  });

  it("reads several result sets in a row", () => {
    expect(parseSqliteJson('[{"a":1}]\n[{"a":2}]\n')).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it.each(['[{"a":1', '[{"a" 1}]', '{"a":1}', '[{"a":"x]', '[{"a":1}x'])(
    "rejects malformed %j",
    (text) => {
      expect(() => parseSqliteJson(text)).toThrow(SqliteJsonError);
    },
  );
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
