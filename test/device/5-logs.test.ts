import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, test } from "vitest";
import { sharedWithToon } from "../helpers/json.js";
import { Axi, DEBUG_APK, PKG, probeState } from "./support.js";

const axi = new Axi(import.meta.filename);

beforeEach(async () => {
  await axi.ok(["app", "install", DEBUG_APK, "--clean-data"]);
  await axi.ok(["app", "start", PKG]);
});

interface LogRow {
  time: string;
  level: string;
  tag: string;
  message: string;
}

/** Log `count` lines of `text` from the probe, then wait for its own `event=log` line. */
async function burst(text: string, count: number, numbered = false): Promise<void> {
  const mark = `burst-${Date.now()}`;
  await axi.mark(mark);
  await axi.probe(
    "log",
    `--ei count ${count} --es text '${text}'${numbered ? " --ez numbered true" : ""}`,
  );
  expect(probeState(await axi.waitLog(`event=log count=${count} `, mark)).count).toBe(
    String(count),
  );
}

/** How many ProbeLog lines with exactly this message logcat itself holds since a mark time. */
async function rawCount(since: string, message: string): Promise<number> {
  const out = await axi.sh(
    `logcat -d -v epoch -T '${since}' -s ProbeLog | grep -c ' ProbeLog: ${message}$' || true`,
  );
  return Number(out.trim());
}

/** The device's local wall clock, `YYYY-MM-DD HH:MM:SS`, for bracketing what adb-axi prints. */
async function deviceTime(): Promise<string> {
  return (await axi.sh("date '+%Y-%m-%d %H:%M:%S'")).trim();
}

describe("logs on real device logs", () => {
  test("marks: an unnamed mark on the device clock, a reserved name, and MARK_NOT_FOUND listing them", async () => {
    const before = await deviceTime();
    const unnamed = sharedWithToon(await axi.ok(["logs", "mark"]));
    const after = await deviceTime();
    const match = new RegExp(
      `^mark mark-(\\d\\d)(\\d\\d)(\\d\\d) -> (\\d{4}-\\d\\d-\\d\\d) (\\d\\d):(\\d\\d):(\\d\\d)\\.\\d{3} on ${axi.serial}$`,
    ).exec(String(unnamed.ok));
    expect(match, String(unnamed.ok)).not.toBeNull();
    const [, nameH, nameM, nameS, day, h, m, s] = match ?? [];
    expect([nameH, nameM, nameS]).toEqual([h, m, s]);
    const printed = `${day} ${h}:${m}:${s}`;
    expect(printed >= before && printed <= after, `${before} <= ${printed} <= ${after}`).toBe(true);
    const name = `mark-${nameH}${nameM}${nameS}`;

    const reserved = sharedWithToon(await axi.ok(["logs", "mark", "constructor"]));
    expect(String(reserved.ok)).toMatch(/^mark constructor -> /);
    await burst("after constructor", 1);
    const scoped = await axi.ok([
      "logs",
      "--pkg",
      PKG,
      "--since",
      "constructor",
      "--grep",
      "after constructor",
    ]);
    expect((scoped.lines as LogRow[]).map((row) => row.message)).toEqual(["after constructor"]);
    expect((await axi.waitLog("after constructor", "constructor")).trim()).toBe(
      "after constructor",
    );

    const none = await axi.ok([
      "logs",
      "--pkg",
      PKG,
      "--since",
      "constructor",
      "--grep",
      "^AXI_NEVER$",
    ]);
    expect(none.counts).toEqual({ matched: 0 });
    expect(none.lines).toEqual([]);

    for (const command of [["logs"], ["wait", "log", "x"], ["logs", "crash"]]) {
      const missing = await axi.fails([...command, "--since", "nope"], "MARK_NOT_FOUND");
      expect(missing.error).toBe(`no log mark named nope on ${axi.serial}`);
      expect((missing.marks as string[]).slice(0, 2)).toEqual([name, "constructor"]);
    }
  });

  test("a burst: the newest 50 rows, repeats folded as logcat kept them, long lines cut, --full keeps all", async () => {
    const since = await axi.mark("burst");
    await burst("line", 60, true);
    await burst("same line", 3);
    await burst("L".repeat(1200), 1);
    await burst("é".repeat(600), 1);
    const same = await rawCount(since, "same line");
    expect(same).toBeGreaterThanOrEqual(1);
    const pattern = "^(line #|same line$|LLLL|éééé)";
    const matched = 60 + same + 2;
    const rows = 60 + 1 + 2;

    const cut = await axi.text(["logs", "--pkg", PKG, "--since", "burst", "--grep", pattern]);
    const lines = cut.data.lines as LogRow[];
    expect(lines).toHaveLength(50);
    expect(lines.slice(-3).map((row) => row.message)).toEqual([
      same === 1 ? "same line" : `same line (repeated ${same}x)`,
      `${"L".repeat(500)}... (truncated, 1200 chars total)`,
      `${"é".repeat(500)}... (truncated, 600 chars total)`,
    ]);
    expect(lines[0]?.message).toBe(`line #${60 - 47 + 1}`);
    expect(cut.data.shown).toEqual({
      rows: `50 of ${rows}, the oldest ${rows - 50} left out`,
      lines:
        same === 1
          ? `${matched} matched`
          : `${matched} matched, ${same - 1} folded into repeated rows`,
      cut: "2 messages over 500 chars",
    });
    expect(cut.data.help).toEqual([
      `Run the same command with \`--full\` to write all ${matched} matched lines to a file`,
    ]);

    const args = ["logs", "--pkg", PKG, "--since", "burst", "--grep", pattern, "--full"];
    const runs = await Promise.all([axi.ok(args), axi.ok(args)]);
    expect(runs[0].full).not.toBe(runs[1].full);
    for (const run of runs) {
      expect(run).not.toHaveProperty("help");
      const file = readFileSync(String(run.full), "utf8").trimEnd().split("\n");
      expect(file).toHaveLength(matched);
      expect(file.filter((line) => line.endsWith(" ProbeLog: same line"))).toHaveLength(same);
      expect(file.some((line) => line.endsWith(`ProbeLog: ${"L".repeat(1200)}`))).toBe(true);
      expect(file.some((line) => line.endsWith(`ProbeLog: ${"é".repeat(600)}`))).toBe(true);
      expect(file[0]).toMatch(/^\d\d:\d\d:\d\d\.\d{3} I ProbeLog: line #1$/);
    }

    const small = await axi.ok([
      "logs",
      "--pkg",
      PKG,
      "--since",
      "burst",
      "--grep",
      "^line #(1|2)$",
      "--full",
    ]);
    expect(small.full).toBe("not written: nothing was cut");
    expect(small).not.toHaveProperty("shown");
  });

  test("the scope follows the API: a uid from API 31, the app's pids before it", async () => {
    const sdk = Number((await axi.sh("getprop ro.build.version.sdk")).trim());
    const uid = /(?:userId|appId)=(\d+)/.exec(
      await axi.sh(`dumpsys package ${PKG} | grep -E 'userId=|appId='`),
    )?.[1];
    expect(uid).toBeDefined();
    const pids = await axi.pidsOf(PKG);
    expect(pids).toHaveLength(1);
    await axi.mark("scope");
    await burst("scoped", 1);
    const logs = await axi.ok(["logs", "--pkg", PKG, "--since", "scope", "--grep", "^scoped$"]);
    expect(logs.scope).toBe(sdk >= 31 ? `${PKG} (uid ${uid})` : `${PKG} (pids ${pids[0]})`);
    expect((logs.lines as LogRow[]).map((row) => row.message)).toEqual(["scoped"]);
  });

  test("windows: 15 minutes by default, a duration on the device clock, and a buffer that starts late", async () => {
    const all = await axi.ok(["logs", "--pkg", PKG]);
    expect(String(all.window)).toMatch(/^15m ago -> now \(900 s\), \d+ lines scanned$/);
    const recent = await axi.ok(["logs", "--pkg", PKG, "--since", "2m"]);
    expect(String(recent.window)).toMatch(/^2m ago -> now \(120 s\), \d+ lines scanned$/);

    // A window before boot predates the buffer without requiring logcat -c to succeed.
    await burst("late buffer", 1);
    const uptime = Number((await axi.sh("cat /proc/uptime")).trim().split(/\s+/)[0]);
    expect(Number.isFinite(uptime) && uptime > 0).toBe(true);
    const duration = Math.ceil(uptime) + 60;
    // Early boot logs can predate the clock being set and fall outside the requested window.
    const start = Number((await axi.sh("date +%s")).trim()) - duration;
    const oldestTime = async (): Promise<string> => {
      const raw = await axi.sh(`logcat -d -v time -m 1 -T ${start.toFixed(3)}`);
      const match = /^\d\d-\d\d (\d\d:\d\d:\d\d\.\d{3})\s/m.exec(raw);
      expect(match, raw).not.toBeNull();
      return match?.[1] ?? "";
    };
    const before = await oldestTime();
    const late = await axi.ok(["logs", "--since", `${duration}s`]);
    const after = await oldestTime();
    const first =
      /^first log line in this window is at (\d\d:\d\d:\d\d\.\d{3}), after the window start; the device log buffer may have dropped earlier lines$/.exec(
        String(late.note),
      );
    expect(first, String(late.note)).not.toBeNull();
    const seconds = (time: string): number =>
      time.split(":").reduce((total, part) => total * 60 + Number(part), 0);
    const beforeAt = seconds(before);
    // Unwrap midnight relative to the first raw read, including pruning between reads.
    const atOrAfter = (time: string): number => {
      const at = seconds(time);
      return at < beforeAt ? at + 24 * 60 * 60 : at;
    };
    const firstAt = atOrAfter(first?.[1] ?? "");
    expect(firstAt).toBeGreaterThanOrEqual(beforeAt);
    expect(firstAt).toBeLessThanOrEqual(atOrAfter(after));
  });

  test("APP_NOT_INSTALLED for a package the device does not have", async () => {
    const missing = `${PKG}.missing`;
    expect(await axi.sh(`pm path ${missing} || true`)).toBe("");
    expect(await axi.fails(["logs", "--pkg", missing], "APP_NOT_INSTALLED")).toEqual({
      error: `${missing} is not installed on ${axi.serial}`,
      code: "APP_NOT_INSTALLED",
      help: [`Run \`adb-axi app list --device ${axi.serial}\` to see the installed packages`],
    });
  });
});

describe("wait log on real device logs", () => {
  test("it polls until a new line arrives, never matches older lines, and a duration reaches back", async () => {
    await burst("old wait line", 1);
    await axi.mark("waiting");
    const waiting = axi.run([
      "wait",
      "log",
      "^new wait line$",
      "--since",
      "waiting",
      "--timeout",
      "30s",
    ]);
    await burst("new wait line", 1);
    const found = await waiting;
    expect(found.exitCode).toBe(0);
    expect(found.json).toMatchObject({ match: { tag: "ProbeLog", message: "new wait line" } });
    expect(found.json.waited_ms).toEqual(expect.any(Number));

    const old = await axi.run(["wait", "log", "^old wait line$", "--timeout", "2s"]);
    expect(old.exitCode).toBe(1);
    expect(old.json).toMatchObject({
      error: 'no log line matching "^old wait line$" within 2 s',
      code: "WAIT_TIMEOUT",
      help: [
        `Run \`adb-axi logs --since 1m --device ${axi.serial}\` to see what the device logged`,
      ],
    });
    const last = old.json.last as { lines_scanned: number; newest: string | null };
    expect(last.lines_scanned).toEqual(expect.any(Number));
    expect(last.newest === null || !last.newest.includes("old wait line")).toBe(true);
    expect(old.durationMs).toBeLessThan(2_000 + 3_000);
    const back = await axi.ok([
      "wait",
      "log",
      "^old wait line$",
      "--since",
      "1m",
      "--timeout",
      "5s",
    ]);
    expect(back.match).toMatchObject({ tag: "ProbeLog", message: "old wait line" });
  });
});
