import {} from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { decode } from "@toon-format/toon";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isProcessAlive } from "../../src/core/exec.js";
import { createFakeAdb, type FakeAdb } from "../fake-adb/harness.js";
import { buildZip } from "../helpers/apk-builder.js";
import type { Response, Rule } from "../fake-adb/scenario.js";
import { runCli, type CliRun } from "../helpers/run.js";
import { sharedWithToon } from "../helpers/json.js";

vi.setConfig({ testTimeout: 40_000 });

const SERIAL = "emulator-5554";
const PKG = "dev.probe";
const ONE_ONLINE = `List of devices attached\n${SERIAL}          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1\n\n`;
const MARGIN_MS = 1500;

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

const lsCall = (pkg = PKG, userId = 0): string[] => [
  "-s",
  SERIAL,
  "shell",
  `run-as ${pkg} --user ${userId} ls -l databases`,
];
const catCall = (name: string, pkg = PKG, userId = 0): string[] => [
  "-s",
  SERIAL,
  "exec-out",
  "run-as",
  pkg,
  "--user",
  String(userId),
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
      rules: [
        { match: ["devices", "-l"], respond: { stdout: ONE_ONLINE } },
        ...rules,
        { match: ["-s", SERIAL, "shell", "am get-current-user"], respond: { stdout: "0\n" } },
      ],
    },
    { env },
  );
  return fake;
}

it("lists and copies only the resolved current user's database", async () => {
  const db = makeDb("CREATE TABLE note(title); INSERT INTO note VALUES ('secondary');");
  const f = device([
    { match: ["-s", SERIAL, "shell", "am get-current-user"], respond: { stdout: "10\n" } },
    { match: lsCall(PKG, 10), respond: { stdout: lsOutput({ "app.db": statSync(db).size }) } },
    { match: catCall("app.db", PKG, 10), respond: { stdoutFile: db } },
  ]);
  const listed = await runCli(["data", "db", PKG, "--json"], f.env);
  expect(listed.exitCode).toBe(0);
  expect((JSON.parse(listed.stdout) as Record<string, unknown>).databases).toEqual([
    { name: "app.db", size: "8 KB", wal: false },
  ]);
  const queried = await runCli(["data", "db", PKG, "SELECT title FROM note", "--json"], f.env);
  expect(queried.exitCode).toBe(0);
  expect((JSON.parse(queried.stdout) as Record<string, unknown>).rows).toEqual([
    { title: "secondary" },
  ]);
  expect(
    f
      .calls()
      .filter((c) => c.argv[2] === "shell" || c.argv[2] === "exec-out")
      .map((c) => c.argv),
  ).toEqual([
    ["-s", SERIAL, "shell", "am get-current-user"],
    lsCall(PKG, 10),
    ["-s", SERIAL, "shell", "am get-current-user"],
    lsCall(PKG, 10),
    catCall("app.db", PKG, 10),
  ]);
  expect(f.unmatched()).toEqual([]);
});

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

/** Make a database with real SQLite, as a file in a scratch directory. */
function makeDb(sql: string, name = "app.db"): string {
  const path = join(scratchDir(), name);
  const db = new DatabaseSync(path);
  db.exec(sql);
  db.close();
  return path;
}

/** Run in both formats; they must carry the same data, field for field. */
async function both(
  f: FakeAdb,
  args: string[],
): Promise<{ toon: CliRun; json: CliRun; data: Record<string, unknown> }> {
  const toon = await runCli(["data", "db", ...args], f.env);
  const json = await runCli(["data", "db", ...args, "--json"], f.env);
  expect(json.exitCode).toBe(toon.exitCode);
  const data = sharedWithToon(JSON.parse(json.stdout) as Record<string, unknown>);
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

describe("data db: reading", () => {
  it("reads an R-Tree table from the app database", async () => {
    const db = makeDb(
      "CREATE VIRTUAL TABLE bounds USING rtree(id,minX,maxX); INSERT INTO bounds VALUES (1,2,3);",
    );
    const f = deviceWith({ "app.db": db });
    const { toon, data } = await both(f, [PKG, "SELECT * FROM bounds"]);
    expect(toon.exitCode).toBe(0);
    expect(data.rows).toEqual([{ id: 1, minX: 2, maxX: 3 }]);
    expect(f.unmatched()).toEqual([]);
  });

  it("leaves the copy's wal alone when the log is empty", async () => {
    const db = makeDb("CREATE TABLE t(v); INSERT INTO t VALUES (1);");
    const empty = join(scratchDir(), "empty-wal");
    writeFileSync(empty, "");
    const f = deviceWith({ "app.db": db, "app.db-wal": empty });
    const { data } = await both(f, [PKG, "SELECT v FROM t"]);
    expect(data.rows).toEqual([{ v: 1 }]);
    expect(data.db).toMatch(/^app\.db \(no WAL, /);
  });

  it("spills a large sort only inside the private query directory and removes it", async () => {
    const tmp = scratchDir();
    const db = makeDb("CREATE TABLE t(v);");
    const f = deviceWith({ "app.db": db }, { TMPDIR: tmp });
    const seen = new Set<string>();
    const modes = new Set<number>();
    const directoryWatchers = new Map<string, ReturnType<typeof watch>>();
    const watcher = watch(tmp, (_event, filename) => {
      if (filename === null) return;
      seen.add(filename);
      const dir = join(tmp, filename);
      const stat = statSync(dir, { throwIfNoEntry: false });
      if (stat?.isDirectory() && !directoryWatchers.has(filename)) {
        modes.add(stat.mode & 0o777);
        // Watch directly while adb copies the database. Linux's recursive watcher can
        // miss SQLite scratch files that are created and immediately unlinked.
        directoryWatchers.set(
          filename,
          watch(dir, (_event, child) => {
            if (child !== null) seen.add(join(filename, child));
          }),
        );
      }
    });
    try {
      const sql =
        "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<65536) " +
        "SELECT count(*) AS n FROM (SELECT printf('%01024d',x) AS v FROM c ORDER BY v DESC)";
      const run = await runCli(["data", "db", PKG, sql, "--json"], f.env);
      expect(run.exitCode).toBe(0);
      expect(JSON.parse(run.stdout)).toMatchObject({ rows: [{ n: 65536 }] });
      expect([...seen].some((name) => /[/\\]etilqs_/.test(name))).toBe(true);
      expect([...seen].every((name) => /^adb-axi-db-[^/\\]+(?:[/\\]|$)/.test(name))).toBe(true);
      expect([...modes]).toEqual([0o700]);
      expect(readdirSync(tmp)).toEqual([]);
      expect(f.unmatched()).toEqual([]);
    } finally {
      watcher.close();
      for (const child of directoryWatchers.values()) child.close();
    }
  });

  it("never leaves the copy on the host, and sends no host path to adb", async () => {
    const tmp = scratchDir();
    const db = makeDb("CREATE TABLE t(v);");
    const f = deviceWith({ "app.db": db }, { TMPDIR: tmp });
    await both(f, [PKG, "SELECT * FROM t"]);
    await runCli(["data", "db", PKG, "SELEC"], f.env);
    expect(readdirSync(tmp)).toEqual([]);
  });
});

describe("data db: errors", () => {
  it("refuses writefile in a SELECT without writing to the host", async () => {
    const path = join(scratchDir(), "leak.txt");
    const f = deviceWith({ "app.db": makeDb("CREATE TABLE t(v);") });
    const { toon, data } = await both(f, [PKG, `SELECT writefile('${path}', 'leak')`]);
    expect(toon.exitCode).toBe(1);
    expect(data.code).toBe("SQL_ERROR");
    expect(existsSync(path)).toBe(false);
  });

  it.each([
    ["INSERT INTO t VALUES (1)", "INSERT is not a read"],
    [".shell touch /tmp/adb-axi-leak", "dot-commands are not accepted"],
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
});

describe("data db: host files", () => {
  /**
   * An app database whose schema declares a `zipfile` table over a file on the host, as an
   * app can ship it: the schema row is written directly, since this SQLite has no `zipfile`.
   */
  function withHostZipTable(zip: string): string {
    const path = join(scratchDir(), "app.db");
    const db = new DatabaseSync(path, { defensive: false });
    db.exec(
      "CREATE TABLE notes(v); INSERT INTO notes VALUES ('app row'); PRAGMA writable_schema=ON;",
    );
    db.prepare(
      "INSERT INTO sqlite_schema(type, name, tbl_name, rootpage, sql) VALUES ('table', 'archive', 'archive', 0, ?)",
    ).run(`CREATE VIRTUAL TABLE archive USING zipfile('${zip}')`);
    db.close();
    return path;
  }

  function hostZip(): string {
    const zip = join(scratchDir(), "host.zip");
    writeFileSync(zip, buildZip([{ name: "s.txt", data: Buffer.from("host zip sentinel") }]));
    return zip;
  }

  it("refuses a zipfile table the copied schema points at a host file, without its content", async () => {
    const f = deviceWith({ "app.db": withHostZipTable(hostZip()) });
    const { toon, json, data } = await both(f, [
      PKG,
      "SELECT CAST(data AS TEXT) AS content FROM archive",
    ]);
    expect(toon.exitCode).toBe(1);
    expect(data.code).toBe("SQL_ERROR");
    expect(json.stdout).not.toContain("host zip sentinel");
  });

  it("refuses fsdir on a host directory", async () => {
    const dir = scratchDir();
    writeFileSync(join(dir, "host-sentinel.txt"), "host file sentinel");
    const f = deviceWith({ "app.db": makeDb("CREATE TABLE t(v);") });
    const { toon, json, data } = await both(f, [PKG, `SELECT name, data FROM fsdir('${dir}')`]);
    expect(toon.exitCode).toBe(1);
    expect(data.code).toBe("SQL_ERROR");
    expect(json.stdout).not.toContain("host-sentinel");
  });

  it("still reads an ordinary table of a database whose schema declares a zipfile table", async () => {
    const f = deviceWith({ "app.db": withHostZipTable(hostZip()) });
    const { toon, data } = await both(f, [PKG, "SELECT v FROM notes"]);
    expect(toon.exitCode).toBe(0);
    expect(data.rows).toEqual([{ v: "app row" }]);
  });
});

describe("data db: deadlines", () => {
  const TIMEOUT_MS = 1000;

  it.each([["the copy", "copying databases/app.db of dev.probe", catCall("app.db")]])(
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
});
