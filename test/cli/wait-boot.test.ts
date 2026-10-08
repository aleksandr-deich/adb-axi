import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode } from "@toon-format/toon";
import { afterEach, describe, expect, it } from "vitest";
import { isShippedPath, REGISTRY } from "../../src/commands/registry.js";
import { isProcessAlive } from "../../src/core/exec.js";
import { createFakeAdb, type FakeAdb } from "../fake-adb/harness.js";
import {
  UNMATCHED_EXIT,
  UNMATCHED_PREFIX,
  type Response,
  type Rule,
} from "../fake-adb/scenario.js";
import { runCli, type CliRun } from "../helpers/run.js";
import { sharedWithToon } from "../helpers/json.js";

const SERIAL = "emulator-5554";
const TABLET = "emulator-5556";
const BOOT =
  "echo @boot_completed; getprop sys.boot_completed; echo @uptime; cat /proc/uptime; echo @system_server; pidof system_server; echo @package; cmd package path android >/dev/null 2>&1; echo $?; echo @activity; cmd activity get-current-user >/dev/null 2>&1; echo $?; echo @system_server_after; pidof system_server || true";

const line = (serial: string, state: string): string =>
  `${serial}          ${state} product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1\n`;
const devices = (...lines: string[]): Response => ({
  stdout: `List of devices attached\n${lines.join("")}\n`,
});

interface Services {
  /** `pidof system_server`; empty while it is not running. */
  pid?: string;
  pidAfter?: string;
  /** The exit codes of the package and activity calls: 0 answered, 20 is "Can't find service". */
  pkg?: number;
  activity?: number;
}

/**
 * What the boot read prints: the property (empty while unset), `/proc/uptime`, the
 * system_server pid, and the exit codes of the package and activity service calls.
 */
const boot = (
  completed: 0 | 1,
  uptime = "1141.19 3978.79",
  { pid = "585", pidAfter = pid, pkg = 0, activity = 0 }: Services = {},
): Response => ({
  stdout: `@boot_completed\n${completed === 1 ? "1" : ""}\n@uptime\n${uptime}\n@system_server\n${pid}\n@package\n${String(pkg)}\n@activity\n${String(activity)}\n@system_server_after\n${pidAfter}\n`,
});

const UNREAD = {
  boot_completed: "-",
  uptime_s: "-",
  package_service: "-",
  activity_service: "-",
} as const;

const BOOTED = boot(1);
const BOOTING = boot(0, "131.54 400.00", { pid: "", pkg: 20, activity: 20 });
/** Booted, but system_server has not brought up the services yet. */
const NO_SERVICES = boot(1, "1141.19 3978.79", { pkg: 20, activity: 20 });
/** A device up for under five minutes, with its services answering. */
const fresh = (pid: string): Response => boot(1, "31.20 60.00", { pid });

let fake: FakeAdb | undefined;
afterEach(() => {
  fake?.cleanup();
  fake = undefined;
});

/** A scripted adb: the first rule that matches (and is not used up) answers. */
function scenario(rules: Rule[]): FakeAdb {
  fake = createFakeAdb({
    description: "A device booting, as the boot read and adb devices show it",
    evidence: ["G1"],
    synthetic: true,
    source:
      "Line formats of adb devices -l and getprop sys.boot_completed with a real /proc/uptime value; the sequence of states is illustrative",
    rules,
  });
  return fake;
}

function shell(response: Response, options: Partial<Rule> = {}, serial = SERIAL): Rule {
  return { match: ["-s", serial, "shell", BOOT], respond: response, ...options };
}

function listing(response: Response, options: Partial<Rule> = {}): Rule {
  return { match: ["devices", "-l"], respond: response, ...options };
}

/**
 * The same scripted adb as `scenario`, answered by a shell script instead of the TypeScript
 * fake, for cases that check the last observation of a wait that runs out. The final look,
 * taken at the deadline, has 500 ms for its one to three adb calls. Starting the TypeScript
 * fake costs about 50 ms of CPU per call, which a loaded host stretches past that budget: the
 * look then times out and reports nothing read, whatever the scenario says. A shell answers in
 * a few milliseconds. Calls are logged like the fake's, in order, so `calls()` and
 * `unmatched()` still hold; only exact arguments, `stdout`, `times` and `then` are supported.
 */
function quickScenario(rules: Rule[]): FakeAdb {
  const f = scenario(rules);
  const q = shellQuote;
  const answer = (index: number, rule: Rule, response: Response | undefined): string => {
    const { stdout = "", ...rest } = response ?? {};
    if (Object.keys(rest).length > 0) throw new Error("quickScenario answers with stdout only");
    return `answer ${String(index)} ${q(JSON.stringify(rule.match))} ${q(stdout)}`;
  };
  const branches = rules.map((rule, index) => {
    const { match, respond, times, then, ...rest } = rule;
    if (Object.keys(rest).length > 0 || !match.every((arg) => typeof arg === "string")) {
      throw new Error("quickScenario matches exact adb arguments only");
    }
    const test = [
      `[ "$#" -eq ${String(match.length)} ]`,
      ...match.map((arg, i) => `[ "$${String(i + 1)}" = ${q(arg)} ]`),
    ].join(" && ");
    if (times === undefined) return `if ${test}; then ${answer(index, rule, respond)}; fi`;
    const uses = `"$FAKE_ADB_STATE.${String(index)}"`;
    return [
      `if ${test}; then`,
      `  n=0; [ -f ${uses} ] && read -r n < ${uses}`,
      `  if [ "$n" -lt ${String(times)} ]; then echo $((n + 1)) > ${uses}; ${answer(index, rule, respond)}; fi`,
      ...(then === undefined ? [] : [`  ${answer(index, rule, then)}`]),
      `fi`,
    ].join("\n");
  });
  writeFileSync(
    join(f.binDir, "adb"),
    `#!/bin/sh
# The script has no millisecond clock: every call is logged at 0, in the order it ran.
log() { printf '{"event":"start","pid":%s,"tool":"adb","argv":%s,"androidSerial":null,"at":0}\\n' $$ "$1" >> "$FAKE_ADB_LOG"; }
answer() {
  log "$2"
  printf '%s' "$3"
  printf '{"event":"end","pid":%s,"at":0,"rule":%s,"exit":0}\\n' $$ "$1" >> "$FAKE_ADB_LOG"
  exit 0
}
${branches.join("\n")}
printf '${UNMATCHED_PREFIX} adb %s\\n' "$*" >&2
log '["${UNMATCHED_PREFIX}"]'
printf '{"event":"end","pid":%s,"at":0,"rule":null,"exit":${String(UNMATCHED_EXIT)},"unmatched":true}\\n' $$ >> "$FAKE_ADB_LOG"
exit ${String(UNMATCHED_EXIT)}
`,
  );
  return f;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

interface Both {
  toon: CliRun;
  json: CliRun;
  data: Record<string, unknown>;
}

/** Run as TOON and as `--json` against the same scripted answers; the data must match. */
async function both(args: string[], f: FakeAdb): Promise<Both> {
  const toon = await runCli(args, f.env);
  const json = await runCli([...args, "--json"], f.env);
  expect(toon.exitCode).toBe(json.exitCode);
  const data = sharedWithToon(JSON.parse(json.stdout) as Record<string, unknown>);
  const decoded = decode(toon.stdout.trimEnd()) as Record<string, unknown>;
  // Two runs wait for different times; every other field must match exactly.
  expect(withoutWaitTime(decoded)).toEqual(withoutWaitTime(data));
  return { toon, json, data };
}

function withoutWaitTime(data: Record<string, unknown>): Record<string, unknown> {
  if (typeof data.waited_ms !== "number") return data;
  return {
    ...data,
    ok: String(data.ok).replace(/ after \d+ ms$/, " after <n> ms"),
    waited_ms: "<n>",
  };
}

/** One run of a wait whose answers advance with each call, so a second run would start later. */
async function once(args: string[], f: FakeAdb): Promise<Both> {
  const toon = await runCli(args, f.env);
  return { toon, json: toon, data: decode(toon.stdout.trimEnd()) as Record<string, unknown> };
}

/** Every call was answered, and every call after the device list names its device. */
function expectClean(f: FakeAdb, serial = SERIAL): void {
  expect(f.unmatched()).toEqual([]);
  for (const call of f.calls()) {
    if (call.argv[0] !== "devices" && call.argv[2] !== "emu") {
      expect(call.argv.slice(0, 2)).toEqual(["-s", serial]);
    }
  }
}

describe("wait boot", () => {
  it("returns at once, as a no-op, when the device has already booted", async () => {
    const f = scenario([listing(devices(line(SERIAL, "device"))), shell(BOOTED)]);
    const { toon, data } = await both(["wait", "boot"], f);
    expect(toon.exitCode).toBe(0);
    expect(toon.stdout).toMatch(
      /^ok: wait boot emulator-5554 -> already booted \(no-op\)\nwaited_ms: \d+\n$/,
    );
    expect(data).toEqual({
      ok: "wait boot emulator-5554 -> already booted (no-op)",
      waited_ms: expect.any(Number) as number,
    });
    expect(f.calls().filter((call) => call.argv[2] === "shell")).toHaveLength(2);
    expectClean(f);
  });

  it("polls until sys.boot_completed is 1 and reports how long it waited", async () => {
    const f = scenario([
      listing(devices(line(SERIAL, "device"))),
      shell(BOOTING, { times: 2, then: BOOTED }),
    ]);
    const { toon, data } = await once(["wait", "boot"], f);
    expect(toon.exitCode).toBe(0);
    const waited = data.waited_ms;
    expect(typeof waited).toBe("number");
    expect(waited as number).toBeGreaterThanOrEqual(500);
    expect(data).toEqual({
      ok: `wait boot ${SERIAL} -> booted after ${String(waited)} ms`,
      waited_ms: waited,
    });
    expect(f.calls().filter((call) => call.argv[2] === "shell")).toHaveLength(3);
    expectClean(f);
  });

  it("keeps waiting after the boot flag until the package and activity services answer", async () => {
    const f = scenario([
      listing(devices(line(SERIAL, "device"))),
      shell(NO_SERVICES, { times: 1 }),
      shell(boot(1, "1141.19 3978.79", { activity: 20 }), { times: 1 }),
      shell(BOOTED),
    ]);
    const { toon, data } = await once(["wait", "boot"], f);
    expect(toon.exitCode).toBe(0);
    expect(data.ok).toMatch(/^wait boot emulator-5554 -> booted after \d+ ms$/);
    expect(f.calls().filter((call) => call.argv[2] === "shell")).toHaveLength(3);
    expectClean(f);
  });

  it("rejects a service probe spanning a restart even on an older device", async () => {
    const f = scenario([
      listing(devices(line(SERIAL, "device"))),
      shell(boot(1, "1141.19 3978.79", { pidAfter: "912" }), { times: 1 }),
      shell(BOOTED),
    ]);
    const { toon, data } = await once(["wait", "boot"], f);
    expect(toon.exitCode).toBe(0);
    expect(data.ok).toMatch(/^wait boot emulator-5554 -> booted after \d+ ms$/);
    expect(f.calls().filter((call) => call.argv[2] === "shell")).toHaveLength(2);
    expectClean(f);
  });

  it("keeps polling when system_server disappears at the trailing pid read", async () => {
    const f = scenario([
      listing(devices(line(SERIAL, "device"))),
      shell(boot(1, "1141.19 3978.79", { pidAfter: "" }), { times: 1 }),
      shell(BOOTED),
    ]);
    const { toon, data } = await once(["wait", "boot"], f);
    expect(toon.exitCode).toBe(0);
    expect(data.ok).toMatch(/^wait boot emulator-5554 -> booted after \d+ ms$/);
    expect(f.calls().filter((call) => call.argv[2] === "shell")).toHaveLength(2);
    expectClean(f);
  });

  it("on a fresh device, waits for the services to keep answering from one system_server", async () => {
    // system_server 585 answers, then restarts: its services go away and 912 brings them back.
    const f = scenario([
      listing(devices(line(SERIAL, "device"))),
      shell(fresh("585"), { times: 3 }),
      shell(boot(1, "33.00 64.00", { pid: "", pkg: 20, activity: 20 }), { times: 1 }),
      shell(boot(1, "33.40 65.00", { pid: "912", pkg: 0, activity: 20 }), { times: 1 }),
      shell(fresh("912")),
    ]);
    const { toon, data } = await once(["wait", "boot", "--timeout", "30s"], f);
    expect(toon.exitCode).toBe(0);
    const waited = data.waited_ms as number;
    // Five looks at least 400 ms apart before 912 answers in full, then ten seconds of it answering.
    expect(waited).toBeGreaterThanOrEqual(5 * 400 + 10_000);
    expect(data.ok).toBe(`wait boot ${SERIAL} -> booted after ${String(waited)} ms`);
    const looks = f.calls().filter((call) => call.argv[2] === "shell");
    expect(looks.length).toBeGreaterThan(5 + 1);
    expectClean(f);
  }, 40_000);

  it("on a fresh device, does not count a probe spanning a restart toward settle", async () => {
    const f = scenario([
      listing(devices(line(SERIAL, "device"))),
      shell(boot(1, "31.20 60.00", { pid: "585", pidAfter: "912" })),
    ]);
    const { toon, data } = await once(["wait", "boot", "--timeout", "2s"], f);
    expect(toon.exitCode).toBe(1);
    expect(data).toMatchObject({
      code: "WAIT_TIMEOUT",
      error: `${SERIAL} had not finished booting after 2 s`,
    });
    expectClean(f);
  }, 20_000);

  it("on a fresh device, starts the settle again when system_server changes between looks", async () => {
    // The restart falls between two looks, so no look sees the services missing.
    const f = scenario([
      listing(devices(line(SERIAL, "device"))),
      shell(fresh("585"), { times: 3 }),
      shell(fresh("912")),
    ]);
    const { toon, data } = await once(["wait", "boot", "--timeout", "30s"], f);
    expect(toon.exitCode).toBe(0);
    // Looks start at least 400 ms apart, so 912's ten seconds start 1.2 s in.
    expect(data.waited_ms as number).toBeGreaterThanOrEqual(3 * 400 + 10_000);
    expectClean(f);
  }, 40_000);

  it("waits through a device that is not attached yet and one that is still offline", async () => {
    const f = scenario([
      // One look finds nothing attached, one finds the device offline, then it is up and booted.
      listing(devices(), { times: 1 }),
      listing(devices(line(SERIAL, "offline")), { times: 1 }),
      listing(devices(line(SERIAL, "device"))),
      shell(BOOTED),
    ]);
    const { toon, data } = await once(["wait", "boot", "--device", SERIAL], f);
    expect(toon.exitCode).toBe(0);
    expect(data.ok).toMatch(/^wait boot emulator-5554 -> booted after \d+ ms$/);
    expect(f.calls().filter((call) => call.argv[2] === "shell")).toHaveLength(1);
    expectClean(f);
  });

  it("does not switch to a different device after the selected device disconnects", async () => {
    const f = quickScenario([
      listing(devices(line(SERIAL, "device")), { times: 1 }),
      listing(devices(line(TABLET, "device"))),
      {
        match: ["-s", TABLET, "emu", "avd", "name"],
        respond: { stdout: "Pixel_Tablet\r\nOK\r\n" },
      },
      shell(BOOTING),
      shell(BOOTED, {}, TABLET),
    ]);
    const { toon, data } = await once(["wait", "boot", "--timeout", "1s"], f);
    expect(toon.exitCode).toBe(1);
    expect(data).toMatchObject({
      code: "WAIT_TIMEOUT",
      error: `${SERIAL} had not finished booting after 1 s`,
      last: { state: "not attached", ...UNREAD },
    });
    expect(f.calls().filter((call) => call.argv[2] === "shell" && call.argv[1] === TABLET)).toEqual(
      [],
    );
    expect(f.unmatched()).toEqual([]);
  }, 20_000);

  it("resolves the device by AVD name", async () => {
    const f = scenario([
      listing(devices(line(SERIAL, "device"), line(TABLET, "device"))),
      {
        match: ["-s", SERIAL, "emu", "avd", "name"],
        respond: { stdout: "Pixel_10_Pro_XL\r\nOK\r\n" },
      },
      {
        match: ["-s", TABLET, "emu", "avd", "name"],
        respond: { stdout: "Pixel_Tablet\r\nOK\r\n" },
      },
      shell(BOOTED, {}, TABLET),
    ]);
    const { toon, data } = await both(["wait", "boot", "--device", "Pixel_Tablet"], f);
    expect(toon.exitCode).toBe(0);
    expect(data.ok).toBe(`wait boot ${TABLET} -> already booted (no-op)`);
    expectClean(f, TABLET);
  });

  describe("WAIT_TIMEOUT", () => {
    it("carries the last observation: state, boot_completed and uptime_s", async () => {
      const f = quickScenario([
        listing(devices(line(TABLET, "device"))),
        shell(BOOTING, {}, TABLET),
      ]);
      const { toon, data } = await both(["wait", "boot", "--device", TABLET, "--timeout", "3s"], f);
      expect(toon.exitCode).toBe(1);
      expect(toon.stdout).toBe(
        [
          "error: emulator-5556 had not finished booting after 3 s",
          "code: WAIT_TIMEOUT",
          "last:",
          "  state: device",
          "  boot_completed: 0",
          "  uptime_s: 131",
          "  package_service: 0",
          "  activity_service: 0",
          "help[1]: Run `adb-axi doctor --device emulator-5556` to see why",
          "",
        ].join("\n"),
      );
      expect(data).toEqual({
        error: "emulator-5556 had not finished booting after 3 s",
        code: "WAIT_TIMEOUT",
        last: {
          state: "device",
          boot_completed: 0,
          uptime_s: 131,
          package_service: 0,
          activity_service: 0,
        },
        help: ["Run `adb-axi doctor --device emulator-5556` to see why"],
      });
      expectClean(f, TABLET);
    }, 20_000);

    it("carries which service still did not answer after the boot flag", async () => {
      const f = quickScenario([
        listing(devices(line(SERIAL, "device"))),
        shell(boot(1, "1141.19 3978.79", { pkg: 20 })),
      ]);
      const { toon, data } = await both(["wait", "boot", "--timeout", "1s"], f);
      expect(toon.exitCode).toBe(1);
      expect(data).toMatchObject({
        error: `${SERIAL} had not finished booting after 1 s`,
        code: "WAIT_TIMEOUT",
        last: {
          state: "device",
          boot_completed: 1,
          uptime_s: 1141,
          package_service: 0,
          activity_service: 1,
        },
      });
      expectClean(f);
    }, 20_000);

    it("says so when a fresh device was ready but had not answered for the settle yet", async () => {
      const f = quickScenario([listing(devices(line(SERIAL, "device"))), shell(fresh("585"))]);
      // Two independent deadlines can see different last observations on a slow runner.
      const { toon, data } = await once(["wait", "boot", "--timeout", "5s"], f);
      expect(toon.exitCode).toBe(1);
      expect(data).toEqual({
        error: `${SERIAL} had booted, but its services had not answered for 10 s in a row after 5 s`,
        code: "WAIT_TIMEOUT",
        last: {
          state: "device",
          boot_completed: 1,
          uptime_s: 31,
          package_service: 1,
          activity_service: 1,
        },
        help: [`Run \`adb-axi doctor --device ${SERIAL}\` to see why`],
      });
      expectClean(f);
    }, 20_000);

    it("reports an offline device as the last state, with the boot unknown", async () => {
      const f = quickScenario([listing(devices(line(SERIAL, "offline")))]);
      const { toon, data } = await both(["wait", "boot", "--timeout", "2s"], f);
      expect(toon.exitCode).toBe(1);
      expect(data).toMatchObject({
        error: "the device had not finished booting after 2 s",
        code: "WAIT_TIMEOUT",
        last: { state: "offline", ...UNREAD },
      });
      // The boot is never read from a device that is not online.
      expect(f.calls().filter((call) => call.argv[0] === "-s")).toEqual([]);
    }, 20_000);

    it.each([
      ["offline", "offline"],
      ["recovery", "not online"],
    ])(
      "reports the last state for offline and %s attachments",
      async (other, state) => {
        const f = quickScenario([listing(devices(line(SERIAL, "offline"), line(TABLET, other)))]);
        const { toon, data } = await both(["wait", "boot", "--timeout", "1s"], f);
        expect(toon.exitCode).toBe(1);
        expect(data).toMatchObject({
          code: "WAIT_TIMEOUT",
          last: { state, ...UNREAD },
        });
        expect(f.unmatched()).toEqual([]);
      },
      20_000,
    );

    it("names the environment-selected device in the timeout and doctor hint", async () => {
      const f = quickScenario([listing(devices())]);
      const run = await runCli(["wait", "boot", "--timeout", "1s"], {
        ...f.env,
        ANDROID_SERIAL: TABLET,
      });
      expect(run.exitCode).toBe(1);
      expect(decode(run.stdout.trimEnd())).toEqual({
        error: `${TABLET} had not finished booting after 1 s`,
        code: "WAIT_TIMEOUT",
        last: { state: "not attached", ...UNREAD },
        help: [`Run \`adb-axi doctor --device ${TABLET}\` to see why`],
      });
      expect(f.unmatched()).toEqual([]);
    }, 20_000);

    it("reports a device that never attached, and names the one that was asked for", async () => {
      const f = quickScenario([listing(devices())]);
      const { toon, json, data } = await both(
        ["wait", "boot", "--device", TABLET, "--timeout", "2s"],
        f,
      );
      expect(toon.exitCode).toBe(1);
      expect(data).toEqual({
        error: "emulator-5556 had not finished booting after 2 s",
        code: "WAIT_TIMEOUT",
        last: { state: "not attached", ...UNREAD },
        help: ["Run `adb-axi doctor --device emulator-5556` to see why"],
      });
      for (const run of [toon, json]) {
        expect(run.durationMs).toBeGreaterThanOrEqual(2_000);
        expect(run.durationMs).toBeLessThan(5_000);
      }
      expect(f.unmatched()).toEqual([]);
      const observed = f.calls();
      expect(observed.length).toBeGreaterThanOrEqual(2);
      expect(observed.every((call) => call.argv.join(" ") === "devices -l")).toBe(true);
    }, 20_000);

    it("falls back to a plain doctor hint when no device was ever chosen", async () => {
      const f = scenario([listing(devices())]);
      const { data } = await both(["wait", "boot", "--timeout", "1s"], f);
      expect(data).toMatchObject({
        error: "the device had not finished booting after 1 s",
        help: ["Run `adb-axi doctor` to see why"],
      });
    }, 20_000);

    it("keeps the deadline when the boot read never answers, and kills the hung call", async () => {
      const f = scenario([listing(devices(line(SERIAL, "device"))), shell({ hang: true })]);
      const run = await runCli(["wait", "boot", "--timeout", "2s"], f.env);
      expect(run.exitCode).toBe(1);
      expect(run.durationMs).toBeLessThan(2000 + 1500);
      expect(decode(run.stdout.trimEnd())).toMatchObject({
        code: "WAIT_TIMEOUT",
        last: { state: "device", ...UNREAD },
      });
      for (const call of f.calls()) expect(isProcessAlive(call.pid)).toBe(false);
    }, 20_000);

    it("keeps the deadline when the server never answers", async () => {
      const f = scenario([listing({ hang: true })]);
      const run = await runCli(["wait", "boot", "--timeout", "1s"], f.env);
      expect(run.exitCode).toBe(1);
      expect(run.durationMs).toBeLessThan(1000 + 1500);
      // Each look has its own short deadline, so a server that never answers leaves the
      // device state unknown until the wait runs out.
      expect(decode(run.stdout.trimEnd())).toMatchObject({
        code: "WAIT_TIMEOUT",
        last: { state: "unknown" },
      });
    }, 20_000);

    it("uses the 120 s default deadline", async () => {
      const f = scenario([listing(devices(line(SERIAL, "device"))), shell(BOOTED)]);
      const help = await runCli(["wait", "boot", "--help"], f.env);
      expect(help.stdout).toContain('"--timeout <dur>",120s');
      expect(f.calls()).toEqual([]);
    });
  });

  describe("errors that waiting cannot fix", () => {
    it("fails with ADB_NOT_FOUND when there is no adb to ask", async () => {
      const f = scenario([]);
      const empty = mkdtempSync(join(tmpdir(), "adb-axi-no-adb-"));
      try {
        const run = await runCli(["wait", "boot"], { ...f.env, PATH: empty, HOME: empty });
        expect(run.exitCode).toBe(1);
        expect(decode(run.stdout.trimEnd())).toMatchObject({
          code: "ADB_NOT_FOUND",
          error: "adb was not found",
        });
      } finally {
        rmSync(empty, { recursive: true, force: true });
      }
    });

    it("fails at once with DEVICE_UNAUTHORIZED", async () => {
      const f = scenario([listing(devices(line("ZY22ABCDEFG", "unauthorized")))]);
      const { toon, data } = await both(["wait", "boot"], f);
      expect(toon.exitCode).toBe(1);
      expect(toon.durationMs).toBeLessThan(2000);
      expect(data).toMatchObject({ code: "DEVICE_UNAUTHORIZED" });
    });

    it("fails at once with DEVICE_AMBIGUOUS when several are online and none is chosen", async () => {
      fake = createFakeAdb("multi-device.json");
      const { toon, data } = await both(["wait", "boot"], fake);
      expect(toon.exitCode).toBe(1);
      expect(toon.durationMs).toBeLessThan(2000);
      expect(data).toMatchObject({
        error: "2 devices are online and none is selected",
        code: "DEVICE_AMBIGUOUS",
        help: [
          "Run `adb-axi wait boot --device <serial or avd>`",
          "Or export ANDROID_SERIAL=<serial> in this shell",
        ],
      });
      expect(
        fake.calls().filter((call) => call.argv[2] === "shell" && call.argv[3] === BOOT),
      ).toEqual([]);
    });

    it("fails with INVALID_OUTPUT when the device prints something that is not the boot state", async () => {
      const f = scenario([
        listing(devices(line(SERIAL, "device"))),
        shell({ stdout: "unexpected\n" }),
      ]);
      const { toon, data } = await both(["wait", "boot"], f);
      expect(toon.exitCode).toBe(1);
      expect(data).toMatchObject({
        code: "INVALID_OUTPUT",
        error: "reading the boot state of emulator-5554 printed output adb-axi cannot read",
      });
    });
  });

  it("is listed in help, and its help lines name only shipped commands", async () => {
    const f = scenario([]);
    const top = await runCli(["--help"], f.env);
    expect(top.stdout).toContain("adb-axi wait boot");
    const help = await runCli(["wait", "--help"], f.env);
    expect(help.stdout).toContain("adb-axi wait boot");
    expect(isShippedPath(REGISTRY, ["wait", "boot"])).toBe(true);
    expect(f.calls()).toEqual([]);
  });
});
