import { decode } from "@toon-format/toon";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../../src/cli.js";
import type { HostProcess, HostProcessList } from "../../src/host/processes.js";
import { createFakeAdb, type FakeAdb } from "../fake-adb/harness.js";
import type { Response, Rule } from "../fake-adb/scenario.js";
import { runCli } from "../helpers/run.js";
import { sharedWithToon } from "../helpers/json.js";

const SERIAL = "emulator-5554";
const DEVICES = `List of devices attached\n${SERIAL}          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1\n\n`;

const SHELL = {
  dumpsys: "dumpsys activity processes",
  ps: "ps -A -o PID,ARGS",
  logcat: "logcat -d -v epoch -e 'Cannot call disconnect.. while connecting'",
} as const;

const ANDROID_CLI = "com.android.cli.interact.instrumentation/.InstrumentationServer";
const AGENT_DEVICE = "com.callstack.agentdevice.test/.SnapshotInstrumentation";
const RUNNER = "com.example.notes.test/androidx.test.runner.AndroidJUnitRunner";
const MOBILECLI = "app_process / com.mobilenext.mobilecli.DeviceServer";

interface Instrumentation {
  component: string;
  pid: number;
  uiAutomation?: boolean;
  processPackage?: string;
}

/**
 * `dumpsys activity processes` reduced to its header and the active instrumentation
 * section, as `ActivityManagerService.dumpActiveInstruments` and `ActiveInstrumentation.dump`
 * print them (AOSP android-15.0.0_r1). Hashes, uids and pids are illustrative.
 */
function dumpsys(...instrumentations: Instrumentation[]): Response {
  const lines = ["ACTIVITY MANAGER RUNNING PROCESSES (dumpsys activity processes)"];
  if (instrumentations.length > 0) lines.push("  Active instrumentation:");
  instrumentations.forEach(({ component, pid, uiAutomation, processPackage }, index) => {
    const [pkg = ""] = component.split("/");
    const target = processPackage ?? pkg;
    lines.push(
      `    Instrumentation #${index}: ActiveInstrumentation{4be1f0${index} {${component}} 1 procs}`,
      `      mClass=ComponentInfo{${component}} mFinished=false`,
      "      mRunningProcesses:",
      `        #0: ProcessRecord{9d1c2a${index} ${pid}:${target}/u0a21${index}}`,
      `      mTargetProcesses=[ProcessRecord{9d1c2a${index} ${pid}:${target}/u0a21${index}}]`,
      ...(uiAutomation === false
        ? []
        : [`      mUiAutomationConnection=android.app.UiAutomationConnection@5a7c3f${index}`]),
      "      mArguments=Bundle[mParcelledData.dataSize=52]",
    );
  });
  lines.push("", "  OOM levels:", "    SCHED_GROUP_BACKGROUND=0", "");
  return { stdout: lines.join("\n") };
}

/** toybox `ps -A -o PID,ARGS`: a few system processes, then the given rows. */
function ps(...rows: [number, string][]): Response {
  const all: [number, string][] = [
    [1, "init second_stage"],
    [312, "zygote64"],
    [598, "system_server"],
    [2210, "com.google.android.apps.nexuslauncher"],
    ...rows,
  ];
  return {
    stdout: `  PID ARGS\n${all.map(([pid, args]) => `${String(pid).padStart(5)} ${args}`).join("\n")}\n`,
  };
}

/** One `logcat -v epoch` line, as liblog prints it; the time and tid are illustrative. */
function wedgeLog(pid: number): Response {
  return {
    stdout: `--------- beginning of main\n1790834111.087  ${pid}  ${pid + 17} E InstrumentationServer: java.lang.IllegalStateException: Cannot call disconnect() while connecting UiAutomation@4f2a9c1\n`,
  };
}

const NO_WEDGE: Response = { stdout: "--------- beginning of main\n" };

const HOST_NOISE: HostProcess[] = [
  { pid: 1, args: "/sbin/launchd" },
  { pid: 811, args: "-zsh" },
  { pid: 902, args: "/Applications/Android Studio.app/Contents/MacOS/studio" },
];

const HOST = {
  agentDevice: {
    pid: 4242,
    args: "node /opt/homebrew/lib/node_modules/agent-device/dist/daemon.js",
  },
  gradle: {
    pid: 5150,
    args: "/usr/bin/java -Xmx64m -classpath /repo/gradle/wrapper/gradle-wrapper.jar org.gradle.wrapper.GradleWrapperMain connectedDebugAndroidTest",
  },
  amInstrument: { pid: 6161, args: `adb -s ${SERIAL} shell am instrument -w ${RUNNER}` },
  amInstrumentElsewhere: {
    pid: 6162,
    args: `adb -s emulator-5556 shell am instrument -w ${RUNNER}`,
  },
  mobileMcp: { pid: 7070, args: "node /Users/dev/.npm/_npx/4c1f/node_modules/.bin/mobile-mcp" },
} satisfies Record<string, HostProcess>;

interface Setup {
  dumpsys?: Response;
  ps?: Response;
  logcat?: Response;
  forwards?: Response;
  /** Rules tried before the defaults, for state-driven `--fix` runs. */
  rules?: Rule[];
  state?: Record<string, string>;
  devices?: string;
  serial?: string;
}

let fake: FakeAdb | undefined;
afterEach(() => {
  fake?.cleanup();
  fake = undefined;
  process.exitCode = undefined;
});

const shell = (command: string): Rule["match"] => ["-s", SERIAL, "shell", command];

function scenario(setup: Setup = {}): FakeAdb {
  const serial = setup.serial ?? SERIAL;
  fake = createFakeAdb({
    description: "A scripted emulator for doctor ui: holders on the device, logcat and forwards",
    evidence: ["L9"],
    synthetic: true,
    source:
      "Follows the print statements of ActivityManagerService.dumpActiveInstruments and ActiveInstrumentation.dump (AOSP android-15.0.0_r1), toybox ps -o ARGS, liblog logprint.cpp (-v epoch) and adb forward --list; holder names are the ones droid-eval section 3.6 saw; pids, hashes and times are illustrative",
    ...(setup.state === undefined ? {} : { state: setup.state }),
    rules: [
      ...(setup.rules ?? []),
      { match: ["devices", "-l"], respond: { stdout: setup.devices ?? DEVICES } },
      { match: ["-s", serial, "emu", "avd", "name"], respond: { stdout: "Pixel_10_Pro_XL\nOK\n" } },
      { match: ["-s", serial, "shell", "am get-current-user"], respond: { stdout: "0\n" } },
      { match: ["-s", serial, "shell", SHELL.dumpsys], respond: setup.dumpsys ?? dumpsys() },
      { match: ["-s", serial, "shell", SHELL.ps], respond: setup.ps ?? ps() },
      { match: ["-s", serial, "shell", SHELL.logcat], respond: setup.logcat ?? NO_WEDGE },
      { match: ["forward", "--list"], respond: setup.forwards ?? { stdout: "" } },
    ],
  });
  return fake;
}

/** What the run left in `process.exitCode`; a function, so the reset above it does not narrow it. */
function currentExitCode(): number {
  const code = process.exitCode;
  return typeof code === "number" ? code : Number(code ?? 0);
}

interface Run {
  exitCode: number;
  data: Record<string, unknown>;
  toon: string;
}

/**
 * Run `adb-axi <args>` once per format through the CLI entry; both must carry the same data.
 * The device starts from the same state each time, so a `--fix` run is compared like for like.
 */
async function cli(
  f: FakeAdb,
  args: string[],
  host: HostProcess[] | null = HOST_NOISE,
): Promise<Run> {
  const hostProcesses: HostProcessList = () => Promise.resolve(host);
  const once = async (extra: string[]): Promise<{ out: string; exit: number }> => {
    let out = "";
    process.exitCode = undefined;
    await main({
      argv: [...args, ...extra],
      env: f.env,
      hostProcesses,
      stdout: { write: (chunk: string) => (out += chunk) },
    });
    const exit = currentExitCode();
    process.exitCode = undefined;
    return { out, exit };
  };
  const toon = await once([]);
  f.resetVars();
  const json = await once(["--json"]);
  expect(toon.exit).toBe(json.exit);
  const data = sharedWithToon(JSON.parse(json.out) as Record<string, unknown>);
  expect(decode(toon.out.trimEnd())).toEqual(data);
  return { exitCode: toon.exit, data, toon: toon.out };
}

/** Every call reached the target with `-s`, and no call went unanswered. */
function expectAddressed(f: FakeAdb): void {
  expect(f.unmatched()).toEqual([]);
  for (const call of f.calls()) {
    if (call.argv[0] === "devices" || call.argv[0] === "forward") continue;
    expect(call.argv.slice(0, 2)).toEqual(["-s", SERIAL]);
  }
}

const shellCalls = (f: FakeAdb): string[] =>
  f
    .calls()
    .filter((call) => call.argv[2] === "shell")
    .map((call) => call.argv[3] ?? "");

describe("doctor ui", () => {
  describe("report", () => {
    it("reports UiAutomation free when nothing holds it, without reading the log or the host", async () => {
      const f = scenario({
        dumpsys: { stdoutFile: "captured/35/dumpsys-activity-processes-probe-front.txt" },
      });
      let hostRead = false;
      let out = "";
      await main({
        argv: ["doctor", "ui"],
        env: f.env,
        hostProcesses: () => {
          hostRead = true;
          return Promise.resolve([]);
        },
        stdout: { write: (chunk: string) => (out += chunk) },
      });
      expect(process.exitCode ?? 0).toBe(0);
      expect(out).toBe("uiautomation: free\n");
      expect(hostRead).toBe(false);
      expect(shellCalls(f).sort()).toEqual([SHELL.dumpsys, SHELL.ps]);
      expectAddressed(f);

      const { exitCode, data } = await cli(f, ["doctor", "ui"]);
      expect(exitCode).toBe(0);
      expect(data).toEqual({ uiautomation: "free" });
    });

    it("reports a live agent-device session, names what releases it, and exits 0", async () => {
      const f = scenario({ dumpsys: dumpsys({ component: AGENT_DEVICE, pid: 8120 }) });
      const { exitCode, data, toon } = await cli(
        f,
        ["doctor", "ui"],
        [...HOST_NOISE, HOST.agentDevice],
      );
      expect(exitCode).toBe(0);
      expect(toon).toMatchInlineSnapshot(`
        "uiautomation: in use
        holders[1]{pid,holder,state,why}:
          8120,com.callstack.agentdevice.test (agent-device),live,agent-device pid 4242 on the host
        help[1]: Run \`agent-device close\` in the worktree that opened the session when it is done
        "
      `);
      expect(data).toEqual({
        uiautomation: "in use",
        holders: [
          {
            pid: 8120,
            holder: "com.callstack.agentdevice.test (agent-device)",
            state: "live",
            why: "agent-device pid 4242 on the host",
          },
        ],
        help: ["Run `agent-device close` in the worktree that opened the session when it is done"],
      });
      expectAddressed(f);
    });

    it("reports the Android CLI's idle server as resident, says what it blocks, and exits 0", async () => {
      const f = scenario({ dumpsys: dumpsys({ component: ANDROID_CLI, pid: 3773 }) });
      const { exitCode, data } = await cli(f, ["doctor", "ui"]);
      expect(exitCode).toBe(0);
      expect(data).toEqual({
        uiautomation: "in use",
        holders: [
          {
            pid: 3773,
            holder: "com.android.cli.interact.instrumentation (Android CLI)",
            state: "resident",
            why: "no host client",
          },
        ],
        help: [
          `The Android CLI keeps its UI server between \`android\` commands; that is harmless, but it blocks instrumentation tests (Gradle connected* tasks, \`am instrument\`), so run \`adb-axi doctor ui --fix --device ${SERIAL}\` before starting them`,
        ],
      });
      expectAddressed(f);
    });

    it("reports a leaked mobilecli server and a wedged Android CLI server, and exits 1", async () => {
      const f = scenario({
        dumpsys: dumpsys({ component: ANDROID_CLI, pid: 5673 }),
        ps: ps([5443, MOBILECLI]),
        logcat: wedgeLog(5673),
        forwards: { stdout: `${SERIAL} tcp:12000 localabstract:mobilecli-server\n` },
      });
      const { exitCode, data, toon } = await cli(f, ["doctor", "ui"]);
      expect(exitCode).toBe(1);
      expect(toon).toMatchInlineSnapshot(`
        "uiautomation: busy
        holders[2]{pid,holder,state,why}:
          5673,com.android.cli.interact.instrumentation (Android CLI),wedged,logged Cannot call disconnect() while connecting
          5443,mobilecli DeviceServer (mobile-mcp),leaked,no host client
        help[1]: Run \`adb-axi doctor ui --fix --device emulator-5554\` to force-stop com.android.cli.interact.instrumentation and kill pid 5443
        "
      `);
      expect(data).toEqual({
        uiautomation: "busy",
        holders: [
          {
            pid: 5673,
            holder: "com.android.cli.interact.instrumentation (Android CLI)",
            state: "wedged",
            why: "logged Cannot call disconnect() while connecting",
          },
          {
            pid: 5443,
            holder: "mobilecli DeviceServer (mobile-mcp)",
            state: "leaked",
            why: "no host client",
          },
        ],
        help: [
          `Run \`adb-axi doctor ui --fix --device ${SERIAL}\` to force-stop com.android.cli.interact.instrumentation and kill pid 5443`,
        ],
      });
      expectAddressed(f);
    });

    it("counts only the holder's own pid as wedged", async () => {
      const f = scenario({
        dumpsys: dumpsys({ component: AGENT_DEVICE, pid: 5673 }),
        // An earlier holder, long gone, logged the signature under another pid.
        logcat: wedgeLog(4100),
      });
      const { exitCode, data } = await cli(f, ["doctor", "ui"]);
      expect(exitCode).toBe(1);
      expect(data.holders).toEqual([
        {
          pid: 5673,
          holder: "com.callstack.agentdevice.test (agent-device)",
          state: "leaked",
          why: "no host client",
        },
      ]);
    });

    it.each([
      ["a Gradle connected* task", HOST.gradle, "a Gradle connected* task pid 5150 on the host"],
      [
        "adb shell am instrument for this serial",
        HOST.amInstrument,
        "adb shell am instrument pid 6161 on the host",
      ],
    ])("reports a test instrumentation run by %s as live", async (_name, client, why) => {
      const f = scenario({ dumpsys: dumpsys({ component: RUNNER, pid: 9021 }) });
      const { exitCode, data } = await cli(f, ["doctor", "ui"], [...HOST_NOISE, client]);
      expect(exitCode).toBe(0);
      expect(data.uiautomation).toBe("in use");
      expect(data.holders).toEqual([
        { pid: 9021, holder: "com.example.notes.test (am instrument)", state: "live", why },
      ]);
    });

    it("does not count an am instrument run that names another emulator", async () => {
      const f = scenario({ dumpsys: dumpsys({ component: RUNNER, pid: 9021 }) });
      const { exitCode, data } = await cli(
        f,
        ["doctor", "ui"],
        [...HOST_NOISE, HOST.amInstrumentElsewhere],
      );
      expect(exitCode).toBe(1);
      expect(data.holders).toEqual([
        {
          pid: 9021,
          holder: "com.example.notes.test (am instrument)",
          state: "leaked",
          why: "no host client",
        },
      ]);
    });

    it("names both force-stop targets in the leaked instrumentation help", async () => {
      const f = scenario({
        dumpsys: dumpsys({ component: RUNNER, pid: 9021, processPackage: "com.example.notes" }),
      });
      const { exitCode, data } = await cli(f, ["doctor", "ui"]);
      expect(exitCode).toBe(1);
      expect(data.help).toEqual([
        `Run \`adb-axi doctor ui --fix --device ${SERIAL}\` to force-stop com.example.notes.test and force-stop com.example.notes`,
      ]);
    });

    it("treats a host client on another physical device as unrelated", async () => {
      const f = scenario({
        devices: `List of devices attached\nUSB-A device\nUSB-B device\n`,
        serial: "USB-A",
        dumpsys: dumpsys({ component: RUNNER, pid: 9021 }),
      });
      const { exitCode, data } = await cli(
        f,
        ["doctor", "ui", "--device", "USB-A"],
        [...HOST_NOISE, { pid: 6162, args: `adb -s USB-B shell am instrument -w ${RUNNER}` }],
      );
      expect(exitCode).toBe(1);
      expect(data.holders).toEqual([
        {
          pid: 9021,
          holder: "com.example.notes.test (am instrument)",
          state: "leaked",
          why: "no host client",
        },
      ]);
      expect(f.unmatched()).toEqual([]);
    });

    it("ignores an instrumentation without a UiAutomation connection", async () => {
      const f = scenario({
        dumpsys: dumpsys({ component: RUNNER, pid: 9021, uiAutomation: false }),
      });
      const { exitCode, data } = await cli(f, ["doctor", "ui"]);
      expect(exitCode).toBe(0);
      expect(data).toEqual({ uiautomation: "free" });
    });

    it("reports mobilecli live only while mobile-mcp runs and a forward reaches the server", async () => {
      const forward = { stdout: `${SERIAL} tcp:12000 localabstract:mobilecli-server\n` };
      const host = [...HOST_NOISE, HOST.mobileMcp];

      const live = await cli(
        scenario({ ps: ps([5443, MOBILECLI]), forwards: forward }),
        ["doctor", "ui"],
        host,
      );
      expect(live.exitCode).toBe(0);
      expect(live.data.holders).toEqual([
        {
          pid: 5443,
          holder: "mobilecli DeviceServer (mobile-mcp)",
          state: "live",
          why: "mobile-mcp pid 7070 on the host",
        },
      ]);
      fake?.cleanup();

      // The only forward belongs to another device, so no host client can reach this one.
      const elsewhere = { stdout: "emulator-5556 tcp:12000 localabstract:mobilecli-server\n" };
      const leaked = await cli(
        scenario({ ps: ps([5443, MOBILECLI]), forwards: elsewhere }),
        ["doctor", "ui"],
        host,
      );
      expect(leaked.exitCode).toBe(1);
      expect(leaked.data.holders).toEqual([
        {
          pid: 5443,
          holder: "mobilecli DeviceServer (mobile-mcp)",
          state: "leaked",
          why: "mobile-mcp runs on the host but no adb forward reaches the server",
        },
      ]);
    });

    it("treats a holder as live when the host processes cannot be read", async () => {
      const f = scenario({ dumpsys: dumpsys({ component: ANDROID_CLI, pid: 5673 }) });
      const { exitCode, data } = await cli(f, ["doctor", "ui"], null);
      expect(exitCode).toBe(0);
      expect(data).toEqual({
        uiautomation: "in use",
        holders: [
          {
            pid: 5673,
            holder: "com.android.cli.interact.instrumentation (Android CLI)",
            state: "live",
            why: "liveness unknown (host processes unreadable)",
          },
        ],
        help: ["Wait for the `android` command to finish"],
      });
    });

    it("treats a forwarded server as live when the forwards cannot be listed", async () => {
      const f = scenario({
        ps: ps([5443, MOBILECLI]),
        forwards: { exit: 1, stderr: "error: cannot connect to daemon\n" },
      });
      const { exitCode, data } = await cli(f, ["doctor", "ui"]);
      expect(exitCode).toBe(0);
      expect(data.holders).toEqual([
        {
          pid: 5443,
          holder: "mobilecli DeviceServer (mobile-mcp)",
          state: "live",
          why: "liveness unknown (adb forwards unreadable)",
        },
      ]);
    });
  });

  describe("--fix", () => {
    it("is a no-op when UiAutomation is already free", async () => {
      const f = scenario();
      const { exitCode, data, toon } = await cli(f, ["doctor", "ui", "--fix"]);
      expect(exitCode).toBe(0);
      expect(toon).toBe(`ok: doctor ui ${SERIAL} -> uiautomation free (no-op)\n`);
      expect(data).toEqual({ ok: `doctor ui ${SERIAL} -> uiautomation free (no-op)` });
      expect(shellCalls(f).every((command) => !/^(?:kill|am force-stop)/.test(command))).toBe(true);
    });

    it("kills the leaked server, force-stops the wedged instrumentation, and checks again", async () => {
      const f = scenario({
        state: { server: "running", cli: "running" },
        rules: [
          { match: shell("kill 5443"), set: { server: "gone" }, respond: {} },
          {
            match: shell("am force-stop --user 0 com.android.cli.interact.instrumentation"),
            set: { cli: "gone" },
            respond: {},
          },
          {
            match: shell(SHELL.dumpsys),
            when: { cli: "running" },
            respond: dumpsys({ component: ANDROID_CLI, pid: 5673 }),
          },
          { match: shell(SHELL.ps), when: { server: "running" }, respond: ps([5443, MOBILECLI]) },
        ],
        logcat: wedgeLog(5673),
      });
      const { exitCode, data, toon } = await cli(f, ["doctor", "ui", "--fix"]);
      expect(exitCode).toBe(0);
      expect(toon).toMatchInlineSnapshot(`
        "ok: doctor ui emulator-5554 -> uiautomation free (2 cleared)
        cleared[2]{pid,holder,was,action}:
          5673,com.android.cli.interact.instrumentation (Android CLI),wedged,am force-stop --user 0 com.android.cli.interact.instrumentation
          5443,mobilecli DeviceServer (mobile-mcp),leaked,kill 5443
        "
      `);
      expect(data).toEqual({
        ok: `doctor ui ${SERIAL} -> uiautomation free (2 cleared)`,
        cleared: [
          {
            pid: 5673,
            holder: "com.android.cli.interact.instrumentation (Android CLI)",
            was: "wedged",
            action: "am force-stop --user 0 com.android.cli.interact.instrumentation",
          },
          {
            pid: 5443,
            holder: "mobilecli DeviceServer (mobile-mcp)",
            was: "leaked",
            action: "kill 5443",
          },
        ],
      });
      expectAddressed(f);
    });

    it("force-stops only the resolved current user", async () => {
      const f = scenario({
        state: { holder: "running" },
        rules: [
          { match: shell("am get-current-user"), respond: { stdout: "10\n" } },
          { match: shell("am force-stop --user 10 com.example.notes.test"), respond: {} },
          {
            match: shell("am force-stop --user 10 com.example.notes"),
            respond: {},
            set: { holder: "gone" },
          },
          {
            match: shell(SHELL.dumpsys),
            when: { holder: "running" },
            respond: dumpsys({ component: RUNNER, pid: 9021, processPackage: "com.example.notes" }),
          },
        ],
      });
      const { exitCode, data } = await cli(f, ["doctor", "ui", "--fix"]);
      expect(exitCode).toBe(0);
      expect(data.cleared).toEqual([
        {
          pid: 9021,
          holder: "com.example.notes.test (am instrument)",
          was: "leaked",
          action:
            "am force-stop --user 10 com.example.notes.test; am force-stop --user 10 com.example.notes",
        },
      ]);
      expect(shellCalls(f).filter((command) => command.startsWith("am force-stop"))).toEqual([
        "am force-stop --user 10 com.example.notes.test",
        "am force-stop --user 10 com.example.notes",
        "am force-stop --user 10 com.example.notes.test",
        "am force-stop --user 10 com.example.notes",
      ]);
      expectAddressed(f);
    });

    it("stops both the runner and target app process for a leaked test instrumentation", async () => {
      const f = scenario({
        state: { runner: "running", target: "running" },
        rules: [
          {
            match: shell("am force-stop --user 0 com.example.notes.test"),
            set: { runner: "gone" },
            respond: {},
          },
          {
            match: shell("am force-stop --user 0 com.example.notes"),
            set: { target: "gone" },
            respond: {},
          },
          {
            match: shell(SHELL.dumpsys),
            when: { target: "running" },
            respond: dumpsys({ component: RUNNER, pid: 9021, processPackage: "com.example.notes" }),
          },
        ],
      });
      const { exitCode, data } = await cli(f, ["doctor", "ui", "--fix"]);
      expect(exitCode).toBe(0);
      expect(data).toEqual({
        ok: `doctor ui ${SERIAL} -> uiautomation free (1 cleared)`,
        cleared: [
          {
            pid: 9021,
            holder: "com.example.notes.test (am instrument)",
            was: "leaked",
            action:
              "am force-stop --user 0 com.example.notes.test; am force-stop --user 0 com.example.notes",
          },
        ],
      });
      expect(shellCalls(f).filter((command) => command.startsWith("am force-stop"))).toEqual([
        "am force-stop --user 0 com.example.notes.test",
        "am force-stop --user 0 com.example.notes",
        "am force-stop --user 0 com.example.notes.test",
        "am force-stop --user 0 com.example.notes",
      ]);
      expectAddressed(f);
    });

    it("clears an unrelated orphaned instrumentation while protecting a named live run", async () => {
      const live = { component: "a.live.test/.Runner", pid: 9001, processPackage: "live.app" };
      const leaked = {
        component: "b.leaked.test/.Runner",
        pid: 9002,
        processPackage: "leaked.app",
      };
      const f = scenario({
        state: { orphan: "running" },
        rules: [
          { match: shell("am force-stop --user 0 b.leaked.test"), respond: {} },
          {
            match: shell("am force-stop --user 0 leaked.app"),
            set: { orphan: "gone" },
            respond: {},
          },
          {
            match: shell(SHELL.dumpsys),
            when: { orphan: "running" },
            respond: dumpsys(live, leaked),
          },
        ],
        dumpsys: dumpsys(live),
      });
      const { exitCode, data } = await cli(
        f,
        ["doctor", "ui", "--fix"],
        [
          ...HOST_NOISE,
          { pid: 6161, args: `adb -s ${SERIAL} shell am instrument -w a.live.test/.Runner` },
        ],
      );
      expect(exitCode).toBe(1);
      expect(data).toEqual({
        error: "a.live.test (am instrument) is live and --fix left it alone",
        code: "HOLDER_PROTECTED",
        cleared: [
          {
            pid: 9002,
            holder: "b.leaked.test (am instrument)",
            was: "leaked",
            action: "am force-stop --user 0 b.leaked.test; am force-stop --user 0 leaked.app",
          },
        ],
        protected: [
          {
            pid: 9001,
            holder: "a.live.test (am instrument)",
            why: "adb shell am instrument pid 6161 on the host",
          },
        ],
        help: ["Wait for `adb shell am instrument` (pid 6161) to finish, or stop it"],
      });
      expect(shellCalls(f).filter((command) => command.startsWith("am force-stop"))).toEqual([
        "am force-stop --user 0 b.leaked.test",
        "am force-stop --user 0 leaked.app",
        "am force-stop --user 0 b.leaked.test",
        "am force-stop --user 0 leaked.app",
      ]);
      expectAddressed(f);
    });

    it.each([
      [
        "target process package",
        { component: "a.live.test/.Runner", pid: 9001, processPackage: "shared.app" },
        { component: "b.leaked.test/.Runner", pid: 9002, processPackage: "shared.app" },
        "shared.app",
      ],
      [
        "runner package",
        { component: "shared.test/.Live", pid: 9001, processPackage: "live.app" },
        { component: "shared.test/.Leaked", pid: 9002, processPackage: "leaked.app" },
        "shared.test",
      ],
    ])("does not force-stop a %s used by a live holder", async (_name, live, leaked, pkg) => {
      const f = scenario({ dumpsys: dumpsys(live, leaked) });
      const { exitCode, data } = await cli(
        f,
        ["doctor", "ui", "--fix"],
        [
          ...HOST_NOISE,
          { pid: 6161, args: `adb -s ${SERIAL} shell am instrument -w ${live.component}` },
        ],
      );
      expect(exitCode).toBe(1);
      expect(data).toEqual({
        uiautomation: "busy",
        holders: [
          {
            pid: 9001,
            holder: `${live.component.split("/")[0]} (am instrument)`,
            state: "live",
            why: "adb shell am instrument pid 6161 on the host",
          },
          {
            pid: 9002,
            holder: `${leaked.component.split("/")[0]} (am instrument)`,
            state: "leaked",
            why: "no host client",
          },
        ],
        help: [
          `Cannot force-stop ${pkg} while used by a live holder; stop the live holder first`,
          "Wait for `adb shell am instrument` (pid 6161) to finish, or stop it",
        ],
      });
      expect(shellCalls(f).filter((command) => command.startsWith("am force-stop"))).toEqual([]);
      expectAddressed(f);
    });

    it("clears the leaked holder but refuses the live one with HOLDER_PROTECTED", async () => {
      const f = scenario({
        state: { server: "running" },
        rules: [
          { match: shell("kill 5443"), set: { server: "gone" }, respond: {} },
          { match: shell(SHELL.ps), when: { server: "running" }, respond: ps([5443, MOBILECLI]) },
        ],
        dumpsys: dumpsys({ component: AGENT_DEVICE, pid: 8120 }),
      });
      const { exitCode, data, toon } = await cli(
        f,
        ["doctor", "ui", "--fix"],
        [...HOST_NOISE, HOST.agentDevice],
      );
      expect(exitCode).toBe(1);
      expect(toon).toMatchInlineSnapshot(`
        "error: com.callstack.agentdevice.test (agent-device) is live and --fix left it alone
        code: HOLDER_PROTECTED
        cleared[1]{pid,holder,was,action}:
          5443,mobilecli DeviceServer (mobile-mcp),leaked,kill 5443
        protected[1]{pid,holder,why}:
          8120,com.callstack.agentdevice.test (agent-device),agent-device pid 4242 on the host
        help[1]: Run \`agent-device close\` in the worktree that opened the session when it is done
        "
      `);
      expect(data).toEqual({
        error: "com.callstack.agentdevice.test (agent-device) is live and --fix left it alone",
        code: "HOLDER_PROTECTED",
        cleared: [
          {
            pid: 5443,
            holder: "mobilecli DeviceServer (mobile-mcp)",
            was: "leaked",
            action: "kill 5443",
          },
        ],
        protected: [
          {
            pid: 8120,
            holder: "com.callstack.agentdevice.test (agent-device)",
            why: "agent-device pid 4242 on the host",
          },
        ],
        help: ["Run `agent-device close` in the worktree that opened the session when it is done"],
      });
      // The live session's package was never force-stopped.
      expect(shellCalls(f).filter((command) => command.startsWith("am force-stop"))).toEqual([]);
      expectAddressed(f);
    });

    it("refuses a running Gradle test with HOLDER_PROTECTED, touching nothing", async () => {
      const f = scenario({ dumpsys: dumpsys({ component: RUNNER, pid: 9021 }) });
      const { exitCode, data } = await cli(
        f,
        ["doctor", "ui", "--fix"],
        [...HOST_NOISE, HOST.gradle],
      );
      expect(exitCode).toBe(1);
      expect(data).toEqual({
        error: "com.example.notes.test (am instrument) is live and --fix left it alone",
        code: "HOLDER_PROTECTED",
        protected: [
          {
            pid: 9021,
            holder: "com.example.notes.test (am instrument)",
            why: "a Gradle connected* task pid 5150 on the host",
          },
        ],
        help: ["Wait for the Gradle connected* task (pid 5150) to finish, or stop it"],
      });
      expect(shellCalls(f).filter((command) => /^(?:kill|am force-stop)/.test(command))).toEqual(
        [],
      );
    });

    it("exits 1 with what is left when a holder survives the fix", async () => {
      const f = scenario({
        ps: ps([5443, MOBILECLI]),
        rules: [
          {
            match: shell("kill 5443"),
            respond: { exit: 1, stderr: "kill: 5443: Operation not permitted\n" },
          },
        ],
      });
      const { exitCode, data } = await cli(f, ["doctor", "ui", "--fix", "--timeout", "15s"]);
      expect(exitCode).toBe(1);
      expect(data).toEqual({
        uiautomation: "busy",
        holders: [
          {
            pid: 5443,
            holder: "mobilecli DeviceServer (mobile-mcp)",
            state: "leaked",
            why: "no host client",
          },
        ],
        help: [`Run \`adb-axi doctor ui --fix --device ${SERIAL}\` to kill pid 5443`],
      });
      expectAddressed(f);
    }, 20_000);
  });

  describe("errors", () => {
    it("fails with INVALID_OUTPUT when the process dump is not one", async () => {
      const f = scenario({ dumpsys: { stdout: "dumpsys: service activity unavailable\n" } });
      const { exitCode, data } = await cli(f, ["doctor", "ui"]);
      expect(exitCode).toBe(1);
      expect(data).toMatchObject({
        error: "looking for running instrumentations printed output adb-axi cannot read",
        code: "INVALID_OUTPUT",
      });
    });

    it("waits for the sibling read to finish when ps fails", async () => {
      const f = scenario({
        ps: { exit: 1, stderr: "ps: bad -o ARGS\n" },
        dumpsys: { ...dumpsys(), delayMs: 500 },
      });
      const { exitCode, data } = await cli(f, ["doctor", "ui"]);
      expect(exitCode).toBe(1);
      expect(data).toMatchObject({
        code: "REMOTE_EXIT",
        step: "reading the process command lines",
        exit: 1,
        stderr: "ps: bad -o ARGS",
      });
      expect(f.calls().filter((call) => call.argv[2] === "shell")).toHaveLength(4);
      expect(f.calls().every((call) => call.end !== null)).toBe(true);
    });

    it("fails with TIMEOUT at --timeout when the device stops answering, through the bin", async () => {
      const f = scenario({
        logcat: { hang: true },
        dumpsys: dumpsys({ component: ANDROID_CLI, pid: 5673 }),
      });
      const run = await runCli(["doctor", "ui", "--timeout", "1s"], f.env);
      expect(run.exitCode).toBe(1);
      expect(decode(run.stdout.trimEnd())).toMatchObject({
        code: "TIMEOUT",
        step: "searching the log for wedged UiAutomation",
      });
      expect(run.durationMs).toBeLessThan(1000 + 1500);
    });

    it("answers through the bin with the real host process list when nothing holds UiAutomation", async () => {
      const f = scenario();
      const run = await runCli(["doctor", "ui"], f.env);
      expect(run.exitCode).toBe(0);
      expect(run.stdout).toBe("uiautomation: free\n");
      const fix = await runCli(["doctor", "ui", "--fix", "--json"], f.env);
      expect(fix.exitCode).toBe(0);
      expect(JSON.parse(fix.stdout)).toEqual({
        ok: `doctor ui ${SERIAL} -> uiautomation free (no-op)`,
        noop: true,
      });
      expectAddressed(f);
    });
  });
});
