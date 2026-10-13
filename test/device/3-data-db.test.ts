import { describe, expect, test } from "vitest";
import { Axi, DEBUG_APK, PKG, RELEASE_APK } from "./support.js";

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
