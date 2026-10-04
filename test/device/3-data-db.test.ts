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

    const query = await axi.ok(["data", "db", PKG, "SELECT id, text FROM notes"]);
    expect(query.rows).toEqual([{ id: 1, text: "probe-1" }]);
  });

  test("a release build is APP_NOT_DEBUGGABLE", async () => {
    await axi.ok(["app", "install", RELEASE_APK]);
    const run = await axi.run(["data", "db", PKG]);
    expect(run.exitCode).toBe(1);
    expect(run.json.code).toBe("APP_NOT_DEBUGGABLE");
  });
});
