import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode } from "@toon-format/toon";
import { afterEach, describe, expect, it } from "vitest";
import { isShippedPath, REGISTRY } from "../../src/commands/registry.js";
import { createFakeAdb, type FakeAdb } from "../fake-adb/harness.js";
import type { Response, Rule } from "../fake-adb/scenario.js";
import { runCli, type CliRun } from "../helpers/run.js";

const SERIAL = "emulator-5554";
const TABLET = "emulator-5556";
const ONLINE_LINE = `${SERIAL}          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1\n`;
const TABLET_LINE = `${TABLET}          device product:sdk_gtablet_arm64 model:sdk_gtablet_arm64 device:emu64t transport_id:2\n`;
const OFFLINE_TABLET = `${TABLET}          offline transport_id:2\n`;
const list = (...lines: string[]): string => `List of devices attached\n${lines.join("")}\n`;

/** The shell commands doctor sends to the target, one per check. */
const SHELL = {
  boot: "echo @boot_completed; getprop sys.boot_completed; echo @uptime; cat /proc/uptime",
  packages: "pm path android",
  data: "df -k /data",
  animations:
    "settings get global window_animation_scale; settings get global transition_animation_scale; settings get global animator_duration_scale",
  ime: "settings get secure default_input_method",
  processes: "dumpsys activity processes",
} as const;
type Probe = keyof typeof SHELL;

/** `df -k /data` as toybox prints it (AOSP toybox toys/posix/df.c); the numbers are illustrative. */
const df = (availableKib: number): Response => ({
  stdout: `Filesystem       1K-blocks    Used Available Use% Mounted on\n/dev/block/dm-48   5898520 2788180 ${String(availableKib).padStart(9)}  48% /data\n`,
});

const STOCK_IME = "com.google.android.inputmethod.latin/com.android.inputmethod.latin.LatinIME\n";

/**
 * The active instrumentation section of `dumpsys activity processes`, as
 * `ActivityManagerService.dumpActiveInstruments` and `ActiveInstrumentation.dump` print it
 * (AOSP android-15.0.0_r1); the hash, the process and the target info are illustrative.
 */
function instrumentation(component: string, options: { uiAutomation?: boolean } = {}): string {
  const [pkg = ""] = component.split("/");
  return [
    "ACTIVITY MANAGER RUNNING PROCESSES (dumpsys activity processes)",
    "  Active instrumentation:",
    `    Instrumentation #0: ActiveInstrumentation{4be1f09 {${component}} 1 procs}`,
    `      mClass=ComponentInfo{${component}} mFinished=false`,
    "      mRunningProcesses:",
    `        #0: ProcessRecord{9d1c2aa 9021:${pkg}/u0a214}`,
    `      mTargetProcesses=[ProcessRecord{9d1c2aa 9021:${pkg}/u0a214}]`,
    `      mTargetInfo=ApplicationInfo{3c0a1b7 ${pkg}}`,
    "        packageName=" + pkg,
    ...(options.uiAutomation === false
      ? []
      : ["      mUiAutomationConnection=android.app.UiAutomationConnection@5a7c3f1"]),
    "mHasBackgroundActivityStartsPermission=false",
    "mHasBackgroundForegroundServiceStartsPermission=false",
    "      mArguments=Bundle[mParcelledData.dataSize=52]",
    "",
    "  OOM levels:",
    "    SCHED_GROUP_BACKGROUND=0",
    "",
  ].join("\n");
}

const HEALTHY: Record<Probe, Response> = {
  boot: { stdout: "@boot_completed\n1\n@uptime\n1141.19 3978.79\n" },
  packages: { stdout: "package:/system/framework/framework-res.apk\n" },
  data: df(3_110_340),
  animations: { stdout: "0\n0\n0\n" },
  ime: { stdout: STOCK_IME },
  // A real dump with no instrumentation running; it was captured for one package, which
  // prints the same sections as the unfiltered one.
  processes: { stdoutFile: "captured/35/dumpsys-activity-processes-probe-front.txt" },
};

const tempDirs: string[] = [];
let fake: FakeAdb | undefined;
afterEach(() => {
  fake?.cleanup();
  fake = undefined;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

interface Setup {
  /** Replaces what a probe answers; the rest stay healthy. */
  probes?: Partial<Record<Probe, Response>>;
  /** What `adb devices -l` prints. */
  devices?: string;
  /** What `adb version` answers. */
  version?: Response;
  /** What `adb devices -l` answers, overriding `devices`. */
  server?: Response;
  /** What `emu avd name` answers on the target. */
  console?: Response;
  /** The console token file: its text, or `null` for none. */
  token?: string | null;
  /** The device the probes are scripted for. */
  serial?: string;
  rules?: Rule[];
}

/** A scripted emulator that answers every probe like a healthy one unless a test says otherwise. */
function scenario(setup: Setup = {}): FakeAdb {
  const serial = setup.serial ?? SERIAL;
  const home = tempDir("adb-axi-doctor-home-");
  if (setup.token !== null) {
    writeFileSync(join(home, ".emulator_console_auth_token"), setup.token ?? "Xk3mQ9vLw2pT7aZr");
  }
  const probes = { ...HEALTHY, ...setup.probes };
  fake = createFakeAdb(
    {
      description: "A scripted target answering the doctor probes",
      evidence: ["G1"],
      synthetic: true,
      source:
        "Real captures for adb version, adb devices -l, emu avd name and the process dump; the rest follows the print statements of toybox df, settings get and ActivityManagerService.dumpActiveInstruments (AOSP android-15.0.0_r1) with illustrative values",
      rules: [
        ...(setup.rules ?? []),
        {
          match: ["version"],
          respond: setup.version ?? { stdoutFile: "captured/host/adb-version.txt" },
        },
        {
          match: ["devices", "-l"],
          respond: setup.server ?? { stdout: setup.devices ?? list(ONLINE_LINE) },
        },
        ...(Object.keys(SHELL) as Probe[]).map((probe): Rule => ({
          match: ["-s", serial, "shell", SHELL[probe]],
          respond: probes[probe],
        })),
        {
          match: ["-s", serial, "emu", "avd", "name"],
          respond: setup.console ?? { stdoutFile: "captured/35/emu-avd-name.txt" },
        },
      ],
    },
    { env: { HOME: home } },
  );
  return fake;
}

interface Row {
  check: string;
  status: string;
  detail: string;
}

interface Report {
  toon: CliRun;
  json: CliRun;
  data: {
    summary: string;
    target?: string;
    checks: Row[];
    help?: string[];
  };
  rows: Record<string, Row>;
}

/** Run doctor as TOON and as `--json`; the two must carry the same data, field for field. */
async function doctor(f: FakeAdb, args: string[] = []): Promise<Report> {
  const toon = await runCli(["doctor", ...args], f.env);
  const json = await runCli(["doctor", ...args, "--json"], f.env);
  expect(toon.exitCode).toBe(json.exitCode);
  const data = JSON.parse(json.stdout) as Report["data"];
  expect(decode(toon.stdout.trimEnd())).toEqual(data);
  const rows = Object.fromEntries(data.checks.map((row) => [row.check, row]));
  return { toon, json, data, rows };
}

/** The calls to the target, which must all name it with `-s`. */
function expectAddressed(f: FakeAdb, serial = SERIAL): void {
  expect(f.unmatched()).toEqual([]);
  for (const call of f.calls()) {
    if (call.argv[0] === "devices" || call.argv[0] === "version") continue;
    expect(call.argv.slice(0, 2)).toEqual(["-s", serial]);
  }
}

/** Every `Run \`adb-axi ...\`` in the help names a command this build ships. */
function expectHelpShipped(help: readonly string[] | undefined): void {
  for (const line of help ?? []) {
    const command = /^Run `adb-axi ([^`]*)`/.exec(line)?.[1];
    if (command === undefined) continue;
    const words = command.split(" ");
    const end = words.findIndex((word) => /^[-<']/.test(word));
    const path = words.slice(0, end === -1 ? words.length : end);
    const shipped = [2, 1].some((n) => isShippedPath(REGISTRY, path.slice(0, n)));
    expect(shipped, line).toBe(true);
  }
}

const NINE = [
  "adb",
  "server",
  "device",
  "boot",
  "data_free",
  "animations",
  "ime",
  "instrumentation",
  "console_token",
];

describe("doctor", () => {
  it("reports all nine checks ok on a healthy emulator and exits 0", async () => {
    const f = scenario();
    const { toon, data, rows } = await doctor(f);
    expect(toon.exitCode).toBe(0);
    expect(data.checks.map((row) => row.check)).toEqual(NINE);
    expect(data.summary).toBe("9 run, 9 ok, 0 warn, 0 failed");
    expect(data.target).toBe(SERIAL);
    expect(rows.adb?.detail).toMatch(/^37\.0\.0 at \S+\/adb$/);
    expect(rows.server?.detail).toBe("tcp:5037");
    expect(rows.device?.detail).toBe(`${SERIAL} online`);
    expect(rows.boot?.detail).toBe("boot finished");
    expect(rows.data_free?.detail).toBe("3.0G free");
    expect(rows.animations?.detail).toBe("scales 0");
    expect(rows.ime?.detail).toBe("standard keyboard");
    expect(rows.instrumentation?.detail).toBe("none running");
    expect(rows.console_token?.detail).toBe("token present, console answers");
    // The report answers the question, so there is nothing left to suggest.
    expect(data.help).toBeUndefined();
    expect(toon.stdout).toMatch(
      /^summary: "9 run, 9 ok, 0 warn, 0 failed"\ntarget: emulator-5554\nchecks\[9\]\{check,status,detail\}:\n {2}adb,ok,/,
    );
    expectAddressed(f);
  });

  it("sends only reads, every one of them under a deadline", async () => {
    const f = scenario();
    await runCli(["doctor"], f.env);
    const sent = f
      .calls()
      .map((call) => call.argv.slice(call.argv[0] === "-s" ? 2 : 0).join(" "))
      .sort();
    expect(sent).toEqual(
      [
        "devices -l",
        "version",
        "emu avd name",
        ...Object.values(SHELL).map((command) => `shell ${command}`),
      ].sort(),
    );
    expect(f.calls().every((call) => call.end !== null)).toBe(true);
  });

  it("exits 1 for a failed check, with the report shape and no error block", async () => {
    const f = scenario({ probes: { data: df(40_000) } });
    const { toon, data } = await doctor(f);
    expect(toon.exitCode).toBe(1);
    expect(data.summary).toBe("9 run, 8 ok, 0 warn, 1 failed");
    expect(data).not.toHaveProperty("error");
    expect(data).not.toHaveProperty("code");
  });

  it("exits 0 when there are only warnings", async () => {
    const f = scenario({ probes: { animations: { stdout: "1.0\n1.0\n1.0\n" } } });
    const { toon, data } = await doctor(f);
    expect(toon.exitCode).toBe(0);
    expect(data.summary).toBe("9 run, 8 ok, 1 warn, 0 failed");
  });

  describe("adb", () => {
    it("fails when no adb is found anywhere, and runs nothing else", async () => {
      const f = scenario();
      const empty = tempDir("adb-axi-no-adb-");
      const env = { ...f.env, PATH: empty };
      const toon = await runCli(["doctor"], env);
      const json = await runCli(["doctor", "--json"], env);
      expect(toon.exitCode).toBe(1);
      const data = JSON.parse(json.stdout) as Report["data"];
      expect(decode(toon.stdout.trimEnd())).toEqual(data);
      expect(data.summary).toBe("1 run, 0 ok, 0 warn, 1 failed");
      expect(data.checks).toEqual([
        {
          check: "adb",
          status: "failed",
          detail: "not found on PATH, ANDROID_HOME, ANDROID_SDK_ROOT or ~/Library/Android/sdk",
        },
      ]);
      expect(data.help?.[0]).toContain("platform-tools");
      expect(f.calls()).toEqual([]);
    });

    it("warns when adb answers without a version", async () => {
      const f = scenario({ version: { stdout: "Android Debug Bridge\n" } });
      const { toon, rows } = await doctor(f);
      expect(toon.exitCode).toBe(0);
      expect(rows.adb?.status).toBe("warn");
      expect(rows.adb?.detail).toMatch(/^version unknown at \S+\/adb$/);
    });

    it("warns when another adb of a different version would restart the server", async () => {
      const f = scenario();
      const sdk = tempDir("adb-axi-sdk-");
      const bin = join(sdk, "platform-tools");
      mkdirSync(bin);
      writeFileSync(join(bin, "adb"), "#!/bin/sh\nprintf 'Version 35.0.2-12147458\\n'\n");
      chmodSync(join(bin, "adb"), 0o755);
      const toon = await runCli(["doctor"], { ...f.env, ANDROID_HOME: sdk });
      expect(toon.exitCode).toBe(0);
      const rows = decode(toon.stdout.trimEnd()) as unknown as Report["data"];
      const adb = rows.checks.find((row) => row.check === "adb");
      expect(adb?.status).toBe("warn");
      expect(adb?.detail).toMatch(
        /^37\.0\.0 at \S+, but 35\.0\.2 at \S+\/platform-tools\/adb restarts its server$/,
      );
      expect(rows.help?.[0]).toContain("one platform-tools");
    });

    it("stays ok when the other adb is the same version", async () => {
      const f = scenario();
      const sdk = tempDir("adb-axi-sdk-");
      const bin = join(sdk, "platform-tools");
      mkdirSync(bin);
      writeFileSync(join(bin, "adb"), "#!/bin/sh\nprintf 'Version 37.0.0-14910828\\n'\n");
      chmodSync(join(bin, "adb"), 0o755);
      const toon = await runCli(["doctor"], { ...f.env, ANDROID_HOME: sdk });
      const rows = decode(toon.stdout.trimEnd()) as unknown as Report["data"];
      expect(rows.checks.find((row) => row.check === "adb")?.status).toBe("ok");
    });
  });

  describe("server", () => {
    it("warns when the server was not running and adb started it", async () => {
      const f = scenario({
        server: {
          stdout: list(ONLINE_LINE),
          stderr: "* daemon not running; starting now at tcp:5037\n* daemon started successfully\n",
        },
      });
      const { toon, rows, data } = await doctor(f);
      expect(toon.exitCode).toBe(0);
      expect(rows.server).toEqual({
        check: "server",
        status: "warn",
        detail: "tcp:5037 was not running, adb started it just now",
      });
      expect(data.checks).toHaveLength(9);
    });

    it("reports the port of ANDROID_ADB_SERVER_PORT", async () => {
      const f = scenario();
      const toon = await runCli(["doctor"], { ...f.env, ANDROID_ADB_SERVER_PORT: "5038" });
      expect(toon.stdout).toContain('server,ok,"tcp:5038"');
    });

    it("fails when the server cannot be reached, and checks nothing that needs it", async () => {
      const f = scenario({
        server: { exit: 1, stderr: "adb: error: cannot connect to daemon at tcp:5037: refused\n" },
      });
      const { toon, data, rows } = await doctor(f);
      expect(toon.exitCode).toBe(1);
      expect(data.summary).toBe("2 run, 1 ok, 0 warn, 1 failed");
      expect(rows.server?.status).toBe("failed");
      expect(rows.server?.detail).toBe("tcp:5037 is not answering: the adb server did not answer");
      expect(data.help?.[0]).toContain("adb server port");
      expect(f.calls().filter((call) => call.argv[0] === "-s")).toEqual([]);
    });

    it("fails when the server prints something that is not a device list", async () => {
      const f = scenario({ server: { stdout: "unexpected\n" } });
      const { toon, rows } = await doctor(f);
      expect(toon.exitCode).toBe(1);
      expect(rows.server?.detail).toBe("tcp:5037 answered, but not with a device list");
    });

    it("kills a server that never answers at the deadline and still reports", async () => {
      const f = scenario({ server: { hang: true } });
      const { toon, rows } = await doctor(f, ["--timeout", "1s"]);
      expect(toon.exitCode).toBe(1);
      expect(toon.durationMs).toBeLessThan(1000 + 1500);
      expect(rows.server?.status).toBe("failed");
      expect(rows.server?.detail).toMatch(
        /^tcp:5037 is not answering: asking the adb server did not finish/,
      );
    });
  });

  describe("device", () => {
    it("lists the state of every attached device and warns when one is not online", async () => {
      const f = scenario({ devices: list(ONLINE_LINE, OFFLINE_TABLET) });
      const { toon, rows, data } = await doctor(f);
      expect(toon.exitCode).toBe(0);
      expect(rows.device).toEqual({
        check: "device",
        status: "warn",
        detail: `${SERIAL} online, ${TABLET} offline`,
      });
      expect(data.target).toBe(SERIAL);
      expect(data.checks).toHaveLength(9);
    });

    it("reports and selects from the same device snapshot", async () => {
      const f = scenario({
        rules: [
          { match: ["devices", "-l"], respond: { stdout: list(ONLINE_LINE) }, times: 1 },
          { match: ["devices", "-l"], respond: { stdout: list(TABLET_LINE) } },
        ],
      });
      const run = await runCli(["doctor"], f.env);
      expect(run.exitCode).toBe(0);
      const data = decode(run.stdout.trimEnd()) as unknown as Report["data"];
      expect(data.target).toBe(SERIAL);
      expect(data.checks.find((row) => row.check === "device")?.detail).toBe(`${SERIAL} online`);
      expect(f.calls().filter((call) => call.argv[0] === "devices")).toHaveLength(1);
      expectAddressed(f);
    });

    it("runs the remaining checks on the device chosen with --device", async () => {
      const f = scenario({ devices: list(ONLINE_LINE, TABLET_LINE), serial: TABLET });
      const { toon, data, rows } = await doctor(f, ["--device", TABLET]);
      expect(toon.exitCode).toBe(0);
      expect(data.target).toBe(TABLET);
      expect(rows.device?.detail).toBe(`${SERIAL} online, ${TABLET} online`);
      expectAddressed(f, TABLET);
    });

    it("fails with the candidates when several are online and none is selected", async () => {
      const f = scenario({ devices: list(ONLINE_LINE, TABLET_LINE) });
      const { toon, data, rows } = await doctor(f);
      expect(toon.exitCode).toBe(1);
      expect(data.summary).toBe("3 run, 2 ok, 0 warn, 1 failed");
      expect(data).not.toHaveProperty("target");
      expect(rows.device?.status).toBe("failed");
      expect(rows.device?.detail).toContain("2 devices are online and none is selected");
      expect(rows.device?.detail).toContain(`${SERIAL} online, ${TABLET} online`);
      expect(data.help).toContain("Run `adb-axi doctor --device <serial or avd>`");
    });

    it("fails when no device is attached", async () => {
      const f = scenario({ devices: list() });
      const { toon, data, rows } = await doctor(f);
      expect(toon.exitCode).toBe(1);
      expect(data.summary).toBe("3 run, 2 ok, 0 warn, 1 failed");
      expect(rows.device).toEqual({
        check: "device",
        status: "failed",
        detail: "no device is attached",
      });
    });

    it("fails an offline target without pointing back at doctor", async () => {
      const f = scenario({ devices: list(ONLINE_LINE, OFFLINE_TABLET) });
      const { toon, data, rows } = await doctor(f, ["--device", TABLET]);
      expect(toon.exitCode).toBe(1);
      expect(rows.device).toEqual({
        check: "device",
        status: "failed",
        detail: `${TABLET} is offline`,
      });
      expect(data.summary).toBe("3 run, 2 ok, 0 warn, 1 failed");
      expect(JSON.stringify(data.help ?? [])).not.toContain("doctor");
      expect(f.calls().filter((call) => call.argv[0] === "-s")).toEqual([]);
    });

    it("fails an unauthorized target and says how to authorize it", async () => {
      const f = scenario({ devices: list(`ZY22ABCDEFG          unauthorized transport_id:3\n`) });
      const { toon, data, rows } = await doctor(f);
      expect(toon.exitCode).toBe(1);
      expect(rows.device?.status).toBe("failed");
      expect(rows.device?.detail).toContain("has not authorized USB debugging");
      expect(data.help?.[0]).toContain("Accept the USB debugging prompt");
    });

    it("fails a serial that is not attached and lists what is", async () => {
      const f = scenario();
      const { toon, rows } = await doctor(f, ["--device", "bogus-9999"]);
      expect(toon.exitCode).toBe(1);
      expect(rows.device?.status).toBe("failed");
      expect(rows.device?.detail).toContain(
        "no attached device has the serial or AVD name bogus-9999",
      );
      expect(rows.device?.detail).toContain(`${SERIAL} online`);
    });
  });

  describe("boot", () => {
    it("fails while the boot has not completed, with the uptime", async () => {
      const f = scenario({
        probes: { boot: { stdout: "@boot_completed\n\n@uptime\n131.54 400.00\n" } },
      });
      const { toon, rows, data } = await doctor(f);
      expect(toon.exitCode).toBe(1);
      expect(rows.boot).toEqual({
        check: "boot",
        status: "failed",
        detail: "still booting (boot_completed 0, up 2m11s)",
      });
      expect(data.help).toEqual([
        `Run \`adb-axi wait boot --device ${SERIAL}\` to wait for the boot to finish`,
      ]);
      expectHelpShipped(data.help);
    });

    it("warns when the boot is complete but the package manager does not answer", async () => {
      const f = scenario({
        probes: { packages: { exit: 20, stderr: "cmd: Can't find service: package\n" } },
      });
      const { toon, rows } = await doctor(f);
      expect(toon.exitCode).toBe(0);
      expect(rows.boot).toEqual({
        check: "boot",
        status: "warn",
        detail: "boot finished, but the package manager does not answer yet",
      });
    });

    it("fails when the device does not answer in time", async () => {
      const f = scenario({ probes: { boot: { hang: true } } });
      const { toon, rows } = await doctor(f, ["--timeout", "2s"]);
      expect(toon.exitCode).toBe(1);
      expect(toon.durationMs).toBeLessThan(2000 + 1500);
      expect(rows.boot?.status).toBe("failed");
      expect(rows.boot?.detail).toMatch(/^reading the boot state of emulator-5554 did not finish/);
      // The other checks still answered.
      expect(rows.data_free?.status).toBe("ok");
    });

    it("warns, instead of failing the report, when the property output cannot be read", async () => {
      const f = scenario({ probes: { boot: { stdout: "unexpected\n" } } });
      const { toon, rows } = await doctor(f);
      expect(toon.exitCode).toBe(0);
      expect(rows.boot?.status).toBe("warn");
      expect(rows.boot?.detail).toMatch(
        /^could not read it: reading the boot state of emulator-5554/,
      );
    });
  });

  describe("data_free", () => {
    it("is ok with plenty of space", async () => {
      const f = scenario({ probes: { data: df(21_000_000) } });
      const { rows } = await doctor(f);
      expect(rows.data_free).toEqual({ check: "data_free", status: "ok", detail: "20.0G free" });
    });

    it("warns when space is getting tight", async () => {
      const f = scenario({ probes: { data: df(600_000) } });
      const { toon, rows, data } = await doctor(f);
      expect(toon.exitCode).toBe(0);
      expect(rows.data_free).toEqual({
        check: "data_free",
        status: "warn",
        detail: "586M free, getting tight",
      });
      expect(data.help).toEqual([
        `Run \`adb-axi app uninstall <pkg> --device ${SERIAL}\` to free space`,
      ]);
      expectHelpShipped(data.help);
    });

    it("fails when there is too little to install or run", async () => {
      const f = scenario({ probes: { data: df(40_000) } });
      const { toon, rows } = await doctor(f);
      expect(toon.exitCode).toBe(1);
      expect(rows.data_free).toEqual({
        check: "data_free",
        status: "failed",
        detail: "39M free, too little to install or run",
      });
    });

    it("warns when the df output cannot be read", async () => {
      const f = scenario({ probes: { data: { stdout: "df: /data: No such file\n" } } });
      const { toon, rows } = await doctor(f);
      expect(toon.exitCode).toBe(0);
      expect(rows.data_free).toEqual({
        check: "data_free",
        status: "warn",
        detail: "free space on /data is unreadable",
      });
    });
  });

  describe("animations", () => {
    it("is ok with every scale at 0", async () => {
      const { rows } = await doctor(scenario());
      expect(rows.animations).toEqual({ check: "animations", status: "ok", detail: "scales 0" });
    });

    it("warns with the scale and how to turn animations off", async () => {
      const f = scenario({ probes: { animations: { stdout: "1.0\n1.0\n1.0\n" } } });
      const { toon, rows, data } = await doctor(f);
      expect(toon.exitCode).toBe(0);
      expect(rows.animations).toEqual({
        check: "animations",
        status: "warn",
        detail: "scales 1.0, animations can make UI steps flaky",
      });
      expect(data.help).toEqual([
        `Run \`adb-axi shell --device ${SERIAL} -- 'settings put global window_animation_scale 0; settings put global transition_animation_scale 0; settings put global animator_duration_scale 0'\` to turn animations off`,
      ]);
      expectHelpShipped(data.help);
    });

    it("reads a scale that was never set as the default 1.0 and names each differing scale", async () => {
      const f = scenario({ probes: { animations: { stdout: "0\nnull\n0.5\n" } } });
      const { rows } = await doctor(f);
      expect(rows.animations?.detail).toBe(
        "window 0, transition 1.0, animator 0.5, animations can make UI steps flaky",
      );
    });

    it("fails when the settings service does not answer", async () => {
      const f = scenario({
        probes: { animations: { exit: 20, stderr: "cmd: Can't find service: settings\n" } },
      });
      const { toon, rows } = await doctor(f);
      expect(toon.exitCode).toBe(1);
      expect(rows.animations).toEqual({
        check: "animations",
        status: "failed",
        detail: "the settings service does not answer (exit 20)",
      });
    });

    it("warns when the scales cannot be read", async () => {
      const f = scenario({ probes: { animations: { stdout: "1.0\nfast\n1.0\n" } } });
      const { rows } = await doctor(f);
      expect(rows.animations?.status).toBe("warn");
      expect(rows.animations?.detail).toBe("the animation scales are unreadable");
    });
  });

  describe("ime", () => {
    it("is ok with the standard keyboard, and names any other keyboard", async () => {
      expect((await doctor(scenario())).rows.ime?.detail).toBe("standard keyboard");
      const f = scenario({
        probes: { ime: { stdout: "com.touchtype.swiftkey/com.touchtype.KeyboardService\n" } },
      });
      expect((await doctor(f)).rows.ime).toEqual({
        check: "ime",
        status: "ok",
        detail: "com.touchtype.swiftkey",
      });
    });

    it("warns when a test tool's keyboard is still the default", async () => {
      const f = scenario({
        probes: { ime: { stdout: "com.android.adbkeyboard/.AdbIME\n" } },
      });
      const { toon, rows, data } = await doctor(f);
      expect(toon.exitCode).toBe(0);
      expect(rows.ime).toEqual({
        check: "ime",
        status: "warn",
        detail: "com.android.adbkeyboard is still the default keyboard",
      });
      expect(data.help).toEqual([
        `Run \`adb-axi shell --device ${SERIAL} -- 'ime reset'\` to restore the default keyboard`,
      ]);
      expectHelpShipped(data.help);
    });

    it("fails when no default keyboard is set", async () => {
      for (const stdout of ["null\n", "\n"]) {
        const f = scenario({ probes: { ime: { stdout } } });
        const { toon, rows } = await doctor(f);
        expect(toon.exitCode).toBe(1);
        expect(rows.ime).toEqual({
          check: "ime",
          status: "failed",
          detail: "no default keyboard is set, typing goes nowhere",
        });
      }
    });
  });

  describe("instrumentation", () => {
    it("is ok when nothing is instrumented (a real dump)", async () => {
      const { rows } = await doctor(scenario());
      expect(rows.instrumentation).toEqual({
        check: "instrumentation",
        status: "ok",
        detail: "none running",
      });
    });

    it("fails with the package that has UiAutomation in use", async () => {
      const component = "com.example.notes.test/androidx.test.runner.AndroidJUnitRunner";
      const f = scenario({ probes: { processes: { stdout: instrumentation(component) } } });
      const { toon, rows, data } = await doctor(f);
      expect(toon.exitCode).toBe(1);
      expect(rows.instrumentation).toEqual({
        check: "instrumentation",
        status: "failed",
        detail: "UiAutomation is held by com.example.notes.test",
      });
      expect(data.help).toEqual([
        `Run \`adb-axi doctor ui --device ${SERIAL}\` to see what holds UiAutomation`,
      ]);
      expectHelpShipped(data.help);
    });

    it("warns for an instrumentation that holds no UiAutomation connection", async () => {
      const component = "com.example.notes.test/androidx.test.runner.AndroidJUnitRunner";
      const f = scenario({
        probes: { processes: { stdout: instrumentation(component, { uiAutomation: false }) } },
      });
      const { toon, rows } = await doctor(f);
      expect(toon.exitCode).toBe(0);
      expect(rows.instrumentation).toEqual({
        check: "instrumentation",
        status: "warn",
        detail: "com.example.notes.test runs an instrumentation",
      });
    });

    it.each(["", "dumpsys: service activity unavailable\n"])(
      "warns when the process dump has no header: %j",
      async (stdout) => {
        const f = scenario({ probes: { processes: { stdout } } });
        const { toon, rows } = await doctor(f);
        expect(toon.exitCode).toBe(0);
        expect(rows.instrumentation).toEqual({
          check: "instrumentation",
          status: "warn",
          detail:
            "could not read it: looking for running instrumentations printed output adb-axi cannot read",
        });
      },
    );

    it("warns when the process list cannot be read", async () => {
      const f = scenario({ probes: { processes: { exit: 1, stderr: "Can't find service\n" } } });
      const { toon, rows } = await doctor(f);
      expect(toon.exitCode).toBe(0);
      expect(rows.instrumentation?.status).toBe("warn");
      expect(rows.instrumentation?.detail).toMatch(
        /^could not read it: looking for running instrumentations failed/,
      );
    });
  });

  describe("console_token", () => {
    it("is ok when the token is present and the console answers", async () => {
      const { rows } = await doctor(scenario());
      expect(rows.console_token).toEqual({
        check: "console_token",
        status: "ok",
        detail: "token present, console answers",
      });
    });

    it("is ok for a physical device, which has no console", async () => {
      const phone = "R5CT123ABCD";
      const f = scenario({
        serial: phone,
        devices: list(
          `${phone}          device usb:1-1 product:panther model:Pixel_7 device:panther transport_id:5\n`,
        ),
        token: null,
      });
      const { toon, rows, data } = await doctor(f);
      expect(toon.exitCode).toBe(0);
      expect(data.target).toBe(phone);
      expect(rows.console_token).toEqual({
        check: "console_token",
        status: "ok",
        detail: "no console on a physical device",
      });
      expectAddressed(f, phone);
    });

    it("warns when the token file is missing", async () => {
      const f = scenario({ token: null });
      const { toon, rows, data } = await doctor(f);
      expect(toon.exitCode).toBe(0);
      expect(rows.console_token?.status).toBe("warn");
      expect(rows.console_token?.detail).toMatch(
        /^\S*\.emulator_console_auth_token is missing, the emulator console may refuse commands$/,
      );
      expect(data.help).toEqual(["Restart the emulator so it writes a fresh console token"]);
    });

    it("fails when the token file is empty", async () => {
      const f = scenario({ token: "  \n" });
      const { toon, rows } = await doctor(f);
      expect(toon.exitCode).toBe(1);
      expect(rows.console_token?.status).toBe("failed");
      expect(rows.console_token?.detail).toMatch(/^\S*\.emulator_console_auth_token is empty$/);
    });

    it.each(["", "OK\r\n", "KO: authentication required\r\n", "not a name\r\n"])(
      "fails when the console does not return an AVD name (%j)",
      async (stdout) => {
        const f = scenario({ console: { stdout } });
        const { toon, rows } = await doctor(f);
        expect(toon.exitCode).toBe(1);
        expect(rows.console_token).toEqual({
          check: "console_token",
          status: "failed",
          detail: "present, but the emulator console did not answer",
        });
        expectAddressed(f);
      },
    );

    it("fails when the token is there but the console says nothing (a silent emu failure)", async () => {
      const f = scenario({ console: { exit: 1 } });
      const { toon, rows } = await doctor(f);
      expect(toon.exitCode).toBe(1);
      expect(rows.console_token).toEqual({
        check: "console_token",
        status: "failed",
        detail: "present, but the emulator console did not answer",
      });
    });
  });

  describe("help lines", () => {
    it("points at doctor ui, never at doctor --fix, and names only shipped commands", async () => {
      expect(isShippedPath(REGISTRY, ["doctor", "ui"])).toBe(true);
      const component = "com.example.notes.test/androidx.test.runner.AndroidJUnitRunner";
      const everythingWrong = scenario({
        probes: {
          boot: { stdout: "@boot_completed\n\n@uptime\n20.00 20.00\n" },
          data: df(40_000),
          animations: { stdout: "1.0\n1.0\n1.0\n" },
          ime: { stdout: "com.android.adbkeyboard/.AdbIME\n" },
          processes: { stdout: instrumentation(component) },
        },
        console: { exit: 1 },
      });
      const { data } = await doctor(everythingWrong);
      expect(data.summary).toBe("9 run, 3 ok, 2 warn, 4 failed");
      const text = JSON.stringify(data);
      expect(data.help).toContain(
        `Run \`adb-axi doctor ui --device ${SERIAL}\` to see what holds UiAutomation`,
      );
      expect(text).not.toContain("--fix");
      expect(data.help?.length).toBeGreaterThan(3);
      expectHelpShipped(data.help);
    });
  });

  describe("registration", () => {
    it("is listed in help with doctor ui as its subcommand, and never offers doctor --fix", async () => {
      const f = scenario();
      const top = await runCli(["--help"], f.env);
      expect(top.stdout).toContain("adb-axi doctor,");
      expect(top.stdout).toContain("adb-axi doctor ui,");
      expect(top.stdout).not.toContain("--fix");

      const help = await runCli(["doctor", "--help"], f.env);
      expect(help.exitCode).toBe(0);
      expect(help.stdout).toContain("command: adb-axi doctor");
      expect(help.stdout).toContain("subcommands[1]{command,summary}:\n  adb-axi doctor ui,");
      expect(help.stdout).not.toContain("--fix");
      expect(f.calls()).toEqual([]);
    });

    it("leaves --fix to doctor ui: the report refuses it before touching a device", async () => {
      const f = scenario();
      const report = await runCli(["doctor", "--fix"], f.env);
      expect(report.exitCode).toBe(2);
      expect(decode(report.stdout.trimEnd())).toMatchObject({ code: "VALIDATION_ERROR" });
      expect(f.calls().filter((call) => call.argv[0] === "-s")).toEqual([]);
    });
  });
});
