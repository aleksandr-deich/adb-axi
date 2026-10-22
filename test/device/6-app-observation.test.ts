import { beforeEach, describe, expect, test } from "vitest";
import { sharedWithToon } from "../helpers/json.js";
import { Axi, DEBUG_APK, PKG, RELEASE_APK, probeState } from "./support.js";

const axi = new Axi(import.meta.filename);

beforeEach(async () => {
  await axi.ok(["app", "install", DEBUG_APK, "--clean-data"]);
  await axi.ok(["app", "start", PKG, "--fresh"]);
  await axi.waitFocused((component) => component === `${PKG}/.MainActivity`);
});

function normalized(data: Record<string, unknown>): Record<string, unknown> {
  const result = { ...sharedWithToon(data) };
  if (typeof result.window === "string") {
    expect(result.window).toMatch(/, \d+ lines scanned$/);
    result.window = result.window
      .replace(/\(\d+ s\)/, "(<s> s)")
      .replace(/\d+ lines scanned$/, "<n> lines scanned");
  }
  if (typeof result.db === "string") {
    expect(result.db).toMatch(/copied \d\d:\d\d:\d\d/);
    result.db = result.db.replace(/copied \d\d:\d\d:\d\d/, "copied <time>");
  }
  if (typeof result.waited_ms === "number") {
    result.waited_ms = "<ms>";
    result.ok = String(result.ok).replace(/ after \d+ ms$/, " after <ms> ms");
  }
  return result;
}

async function parity(args: string[]): Promise<Record<string, unknown>> {
  const json = await axi.ok(args);
  const text = await axi.text(args);
  expect(normalized(text.data)).toEqual(normalized(json));
  return json;
}

interface LogLine {
  time: string;
  level: string;
  tag: string;
  message: string;
}

function lines(data: Record<string, unknown>): LogLine[] {
  return data.lines as LogLine[];
}

function waited(data: Record<string, unknown>, state: string): void {
  expect(data.waited_ms).toEqual(expect.any(Number));
  expect(data.waited_ms).toBeGreaterThanOrEqual(0);
  expect(sharedWithToon(data)).toEqual({
    ok: `wait app ${PKG} -> ${state} after ${String(data.waited_ms)} ms`,
    waited_ms: data.waited_ms,
  });
}

async function roomFiles(): Promise<string> {
  const files = await axi.ok(["shell", `run-as ${PKG} ls -l databases`]);
  expect(files.exit).toBe(0);
  return String(files.stdout);
}

describe("real observation windows and package state", () => {
  test("a named window filters real probe events across process restarts, not unrelated logs", async () => {
    await axi.mark("observation");
    const pids: number[] = [];
    for (const saved of [1, 2, 3]) {
      if (saved !== 1) {
        await axi.ok(["app", "kill", PKG]);
        expect(await axi.pidsOf(PKG)).toEqual([]);
        await axi.ok(["app", "restore", PKG]);
      }
      await axi.probe("inc");
      const state = probeState(
        await axi.waitLog(`event=inc saved=${saved} volatile=1 `, "observation"),
      );
      pids.push(Number(state.pid));
      expect(await axi.pidsOf(PKG)).toEqual([Number(state.pid)]);
    }
    expect(new Set(pids).size).toBe(3);
    await axi.ok(["shell", "log -p i -t AxiOther 'AXI_C_OTHER dev.probe'"]);
    const args = [
      "logs",
      "--since",
      "observation",
      "--level",
      "I",
      "--grep",
      "event=inc|AXI_C_OTHER",
    ];
    const unscoped = await parity(args);
    expect(lines(unscoped).some((line) => line.message === "AXI_C_OTHER dev.probe")).toBe(true);
    const scoped = await parity([...args, "--pkg", PKG]);
    expect(scoped.counts).toEqual({ I: 3 });
    expect(lines(scoped).map((line) => probeState(line.message).saved)).toEqual(["1", "2", "3"]);
    expect(lines(scoped).map((line) => Number(probeState(line.message).pid))).toEqual(pids);
    for (const line of lines(scoped)) {
      expect(Object.keys(line)).toEqual(["time", "level", "tag", "message"]);
      expect(line.level).toBe("I");
      expect(line.tag).toBe("ProbeState");
      expect(line.time).toMatch(/^\d\d:\d\d:\d\d\.\d{3}$/);
    }
    const none = await parity([
      "logs",
      "--since",
      "observation",
      "--pkg",
      PKG,
      "--grep",
      "AXI_C_NEVER",
    ]);
    expect(none.counts).toEqual({ matched: 0 });
    for (const level of ["d", "i", "w", "e"]) {
      await axi.ok(["shell", `log -p ${level} -t AxiLevel 'AXI_C_LEVEL_${level}'`]);
    }
    const levelArgs = ["logs", "--since", "observation", "--grep", "^AXI_C_LEVEL_"];
    const allLevels = await parity(levelArgs);
    expect(lines(allLevels).map((line) => line.level)).toEqual(["D", "I", "W", "E"]);
    const info = await parity([...levelArgs, "--level", "I"]);
    expect(info.counts).toEqual({ I: 1, W: 1, E: 1 });
    expect(lines(info).map((line) => line.message)).toEqual([
      "AXI_C_LEVEL_i",
      "AXI_C_LEVEL_w",
      "AXI_C_LEVEL_e",
    ]);
  });

  test("replacing a named mark excludes the old event and wait-log finds the subsequent oracle", async () => {
    await axi.mark("replacement");
    await axi.probe("inc");
    await axi.waitLog("event=inc saved=1 volatile=1 ", "replacement");
    await axi.mark("replacement");
    await axi.probe("inc");
    const expected = await axi.waitLog("event=inc saved=2 volatile=2 ", "replacement");
    const scoped = await parity([
      "logs",
      "--since",
      "replacement",
      "--pkg",
      PKG,
      "--grep",
      "event=inc",
    ]);
    expect(scoped.counts).toEqual({ I: 1 });
    expect(lines(scoped).map((line) => line.message)).toEqual([expected]);
    const wait = await parity(["wait", "log", "event=inc saved=2", "--since", "replacement"]);
    expect(wait.waited_ms).toEqual(expect.any(Number));
    expect(String(wait.ok)).toMatch(/^wait log event=inc saved=2 -> matched after \d+ ms$/);
    expect(wait.match).toEqual(lines(scoped)[0]);
    expect(Object.keys(sharedWithToon(wait))).toEqual(["ok", "waited_ms", "match"]);
    const old = await parity([
      "logs",
      "--since",
      "replacement",
      "--pkg",
      PKG,
      "--grep",
      "event=inc saved=1",
    ]);
    expect(old.counts).toEqual({ matched: 0 });
    for (const args of [["logs"], ["wait", "log", "event=inc"]]) {
      const json = await axi.run([...args, "--since", "unknown"]);
      expect(json.exitCode).toBe(1);
      expect(json.json).toEqual({
        error: `no log mark named unknown on ${axi.serial}`,
        code: "MARK_NOT_FOUND",
        marks: ["replacement"],
        help: [
          `Run \`adb-axi logs mark unknown --device ${axi.serial}\` to record it now`,
          "Or pass one of the marks listed above, or a duration such as `5m`",
        ],
      });
      expect((await axi.text([...args, "--since", "unknown"], 120_000, 1)).data).toEqual(json.json);
    }
  });

  test("wait-app follows actual foreground, running and stopped states and already-reached results", async () => {
    waited(await parity(["wait", "app", PKG, "--state", "foreground"]), "foreground");
    expect(await axi.focused()).toBe(`${PKG}/.MainActivity`);
    expect(await axi.pidsOf(PKG)).toHaveLength(1);
    waited(await parity(["wait", "app", PKG, "--state", "running"]), "running");
    const stopped = axi.ok(["wait", "app", PKG, "--state", "stopped"]);
    await axi.ok(["app", "stop", PKG]);
    waited(await stopped, "stopped");
    expect(await axi.pidsOf(PKG)).toEqual([]);
    await axi.waitFocused((component) => !component.startsWith(`${PKG}/`));
    waited(await parity(["wait", "app", PKG, "--state", "stopped"]), "stopped");
    const foreground = axi.ok(["wait", "app", PKG, "--state", "foreground"]);
    const running = axi.ok(["wait", "app", PKG, "--state", "running"]);
    await axi.ok(["app", "start", PKG]);
    waited(await foreground, "foreground");
    waited(await running, "running");
    expect(await axi.waitFocused((component) => component === `${PKG}/.MainActivity`)).toBe(
      `${PKG}/.MainActivity`,
    );
    expect(await axi.pidsOf(PKG)).toHaveLength(1);

    // With only the :ui process alive the app is running, but its main process has no pid.
    await axi.ok(["app", "stop", PKG]);
    await axi.sh(`am start -W -n ${PKG}/.UiActivity`);
    expect((await axi.sh(`pidof ${PKG} || true`)).trim()).toBe("");
    expect((await axi.sh(`pidof ${PKG}:ui || true`)).trim()).not.toBe("");
    waited(await parity(["wait", "app", PKG, "--state", "running"]), "running");
    expect((await axi.ok(["app", "info", PKG])).app).toMatchObject({ pid: "-" });
  });

  test("app list and info reflect independent installation, window, kernel and private-size facts", async () => {
    const facts = String(
      (
        await axi.ok([
          "shell",
          `dumpsys package ${PKG} | grep -E 'versionCode=|versionName=|pkgFlags=|flags=|User 0:'`,
        ])
      ).stdout,
    );
    expect(facts).toMatch(/versionCode=1\b/);
    expect(facts).toContain("versionName=1.0");
    expect(facts).toContain("DEBUGGABLE");
    expect(facts).toMatch(/User 0:.*installed=true/);
    const pid = (await axi.pidsOf(PKG))[0];
    expect(pid).toBeGreaterThan(0);
    expect(await axi.focused()).toBe(`${PKG}/.MainActivity`);
    const du = await axi.ok(["shell", `run-as ${PKG} du -sk .`]);
    expect(du.exit).toBe(0);
    const kb = Number(/^\s*(\d+)/.exec(String(du.stdout))?.[1]);
    expect(kb).toBeGreaterThan(0);
    expect((await parity(["app", "info", PKG])).app).toEqual({
      package: PKG,
      installed: true,
      version: "1.0 (1)",
      debuggable: true,
      pid,
      foreground: true,
      data_size: `${kb} KB`,
    });
    const list = await parity(["app", "list", "--grep", "^dev[.]probe$"]);
    expect(list.count).toBe("1 user package shown, 0 system packages hidden");
    expect(list.packages).toEqual([{ package: PKG, version: "1.0 (1)", debuggable: true }]);
    expect(list.help).toEqual([
      `Run \`adb-axi app info ${PKG} --device ${axi.serial}\` for its pid, foreground state and data size`,
    ]);
    const all = await parity(["app", "list", "--all", "--grep", "^dev[.]probe$"]);
    expect(all.count).toBe("1 package shown: 1 user, 0 system");
    expect(all.packages).toEqual(list.packages);
    const none = await parity(["app", "list", "--grep", "^AXI_C_NEVER$"]);
    expect(sharedWithToon(none)).toEqual({
      count: "0 user packages shown, 0 system packages hidden",
      packages: [],
    });
    const rawPackages = async (userOnly: boolean): Promise<string[]> => {
      const query = await axi.ok(["shell", `pm list packages --user 0${userOnly ? " -3" : ""}`]);
      expect(query.exit).toBe(0);
      return String(query.stdout)
        .trim()
        .split("\n")
        .map((line) => line.replace(/^package:/, ""));
    };
    const users = await rawPackages(true);
    const total = await axi.ok(["shell", "pm list packages --user 0 | wc -l"]);
    expect(total.exit).toBe(0);
    const installedCount = Number(total.stdout);
    expect(installedCount).toBeGreaterThan(users.length);
    const systems = installedCount - users.length;
    const userList = await parity(["app", "list"]);
    expect(userList.count).toBe(
      `${users.length} user package${users.length === 1 ? "" : "s"} shown, ${systems} system package${systems === 1 ? "" : "s"} hidden (use --all)`,
    );
    expect((userList.packages as { package: string }[]).map((item) => item.package)).toEqual(
      users.sort(),
    );
    const fullList = await parity(["app", "list", "--all"]);
    expect(fullList.count).toBe(
      `${installedCount} packages shown: ${users.length} user, ${systems} system`,
    );
    expect(
      (fullList.packages as { package: string }[]).some((item) => item.package === "android"),
    ).toBe(true);
    await axi.ok([
      "shell",
      `run-as ${PKG} sh -c 'mkdir -p files && dd if=/dev/zero of=files/axi-size.bin bs=1048576 count=5 2>/dev/null'`,
    ]);
    const largeDu = await axi.ok(["shell", `run-as ${PKG} du -sk .`]);
    expect(largeDu.exit).toBe(0);
    const largeKB = Number(/^\s*(\d+)/.exec(String(largeDu.stdout))?.[1]);
    expect(largeKB).toBeGreaterThanOrEqual(5120);
    expect((await parity(["app", "info", PKG])).app).toMatchObject({
      data_size: `${(largeKB / 1024).toFixed(1)} MB`,
    });
    await axi.ok(["app", "install", RELEASE_APK, "--clean-data"]);
    expect(await axi.pidsOf(PKG)).toEqual([]);
    await axi.waitFocused((component) => !component.startsWith(`${PKG}/`));
    const release = String(
      (await axi.ok(["shell", `dumpsys package ${PKG} | grep -E 'pkgFlags=|flags=|User 0:'`]))
        .stdout,
    );
    expect(release).not.toContain("DEBUGGABLE");
    expect(release).toMatch(/User 0:.*installed=true/);
    expect((await parity(["app", "info", PKG])).app).toEqual({
      package: PKG,
      installed: true,
      version: "1.0 (1)",
      debuggable: false,
      pid: "-",
      foreground: false,
      data_size: "-",
    });
  });

  test("Room listing, WAL rows and empty queries agree with real app-private files", async () => {
    await axi.mark("database");
    await axi.probe("write");
    const state = probeState(
      await axi.waitLog("event=write saved=0 volatile=0 rows=1 ", "database"),
    );
    expect(state.rows).toBe("1");
    const files = await roomFiles();
    expect(files).toMatch(/\sprobe\.db\n/);
    expect(files).toMatch(/\sprobe\.db-wal(?:\n|$)/);
    const stat = await axi.ok(["shell", `run-as ${PKG} stat -c %s databases/probe.db`]);
    expect(stat.exit).toBe(0);
    const size = Number(stat.stdout);
    expect(size).toBeGreaterThan(0);
    const listing = await parity(["data", "db", PKG]);
    expect(listing.count).toBe("1 database");
    expect(listing.databases).toEqual([
      { name: "probe.db", size: `${Math.round(size / 1024)} KB`, wal: true },
    ]);
    expect(listing.help).toEqual([
      `Run \`adb-axi data db ${PKG} 'SELECT name, sql FROM sqlite_master' --device ${axi.serial}\` to read its schema`,
    ]);
    const query = await parity(["data", "db", PKG, "SELECT id, text FROM notes"]);
    expect(query.rows).toEqual([{ id: 1, text: "probe-1" }]);
    expect(String(query.db)).toMatch(/^probe\.db \(with WAL, copied \d\d:\d\d:\d\d\)$/);
    await axi.ok(["app", "clear", PKG]);
    expect(await axi.pidsOf(PKG)).toEqual([]);
    const missing = await parity(["data", "db", PKG]);
    expect(sharedWithToon(missing)).toEqual({ count: "0 databases", databases: [] });
    await axi.ok(["app", "start", PKG, "--fresh"]);
    await axi.probe("state");
    expect(
      probeState(await axi.waitLog("event=state saved=0 volatile=0 rows=0 ", "database")).rows,
    ).toBe("0");
    const empty = await parity(["data", "db", PKG, "SELECT id, text FROM notes"]);
    expect(empty.count).toBe("0 rows");
    expect(empty.rows).toEqual([]);
  });
});

describe("reads with nothing of the probe's in front", () => {
  test("app current names the launcher in front, with its own activity and pid", async () => {
    await axi.sh("input keyevent KEYCODE_HOME");
    const component = await axi.waitFocused((value) => !value.startsWith(`${PKG}/`));
    const [launcher, activity] = component.split("/");
    const pids = await axi.pidsOf(launcher ?? "");
    expect(pids).toHaveLength(1);
    expect(await parity(["app", "current"])).toEqual({
      app: { package: launcher, activity, pid: pids[0] },
    });
  });

  test("app info and app list say plainly what is not installed", async () => {
    await axi.ok(["app", "uninstall", PKG]);
    expect(await axi.sh(`pm path ${PKG} || true`)).toBe("");
    expect(await parity(["app", "info", PKG])).toEqual({
      app: { package: PKG, installed: false },
    });
    const users = (await axi.sh("pm list packages --user 0 -3")).trim();
    const userCount = users === "" ? 0 : users.split("\n").length;
    const systemCount =
      Number((await axi.sh("pm list packages --user 0 | wc -l")).trim()) - userCount;
    const list = await parity(["app", "list"]);
    expect(list.count).toBe(
      `${userCount} user package${userCount === 1 ? "" : "s"} shown, ${systemCount} system packages hidden (use --all)`,
    );
    expect(list.packages).toHaveLength(userCount);
  });

  test("wait app gives up at its deadline with the last state it saw", async () => {
    await axi.ok(["app", "stop", PKG]);
    await axi.sh("input keyevent KEYCODE_HOME");
    const front = (await axi.waitFocused((value) => !value.startsWith(`${PKG}/`))).split("/")[0];
    const run = await axi.run(["wait", "app", PKG, "--state", "foreground", "--timeout", "2s"]);
    expect(run.exitCode).toBe(1);
    expect(run.durationMs).toBeLessThan(2_000 + 1_500);
    expect(run.json).toEqual({
      error: `${PKG} did not reach foreground within 2 s`,
      code: "WAIT_TIMEOUT",
      last: { state: "stopped", pid: "-", foreground: front },
      help: [
        `Run \`adb-axi app info ${PKG} --device ${axi.serial}\` for its pid and foreground state`,
        `Run \`adb-axi app current --device ${axi.serial}\` to see what is in front`,
      ],
    });
    expect(
      (await axi.text(["wait", "app", PKG, "--state", "foreground", "--timeout", "2s"], 30_000, 1))
        .data,
    ).toEqual(run.json);
    expect(await axi.pidsOf(PKG)).toEqual([]);
  });
});
