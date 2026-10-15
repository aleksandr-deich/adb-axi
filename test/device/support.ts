import { appendFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { decode } from "@toon-format/toon";
import { afterAll, beforeAll, beforeEach, expect, inject } from "vitest";
import { locateAdb } from "../../src/adb/locate.js";
import { exec } from "../../src/core/exec.js";

export const PKG = "dev.probe";
export const DEBUG_APK = resolve(import.meta.dirname, "..", "fixtures", "apk", "probe-debug.apk");
export const RELEASE_APK = resolve(
  import.meta.dirname,
  "..",
  "fixtures",
  "apk",
  "probe-release.apk",
);

/** A code-free build of `dev.probe` from `probe-app/variants`, such as `v2` or `othersigner`. */
export function variantApk(name: string): string {
  return resolve(import.meta.dirname, "..", "fixtures", "apk", `probe-${name}.apk`);
}

export interface AdbRun {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface AxiRun {
  args: readonly string[];
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  /** stdout parsed as JSON; every call passes `--json`. */
  json: Record<string, unknown>;
}

export interface AxiText {
  stdout: string;
  data: Record<string, unknown>;
}

/**
 * The installed adb-axi bound to one emulator. Every call names the device by serial and is
 * appended to this test file's transcript; `run` asks for JSON, `text` for the default output.
 */
export class Axi {
  readonly serial: string;
  private readonly bin: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly home: string;
  private readonly transcript: string;
  private readonly failureLog: string;

  constructor(testFile: string) {
    const device = inject("device");
    const name = basename(testFile, ".test.ts");
    const home = join(device.home, name);
    mkdirSync(home, { recursive: true });
    this.serial = device.serial;
    this.bin = device.bin;
    this.env = { ...process.env, ADB_AXI_HOME: home };
    this.home = home;
    this.transcript = join(device.transcripts, `${name}.txt`);
    this.failureLog = join(device.transcripts, `${name}.logcat.txt`);
    beforeEach(({ task, onTestFailed }) => {
      this.freshHome();
      appendFileSync(this.transcript, `# test: ${task.name}\n`);
      onTestFailed(() => this.saveDeviceLog(task.name));
    });
  }

  /** The `ADB_AXI_HOME` the next call uses. */
  get stateHome(): string {
    return this.env.ADB_AXI_HOME ?? "";
  }

  freshHome(): string {
    const home = mkdtempSync(join(this.home, "test-"));
    this.env.ADB_AXI_HOME = home;
    return home;
  }

  /** Run one command; the exit code is the caller's to check. */
  async run(args: readonly string[], deadlineMs = 120_000): Promise<AxiRun> {
    const call = await this.call([...args, "--device", this.serial, "--json"], deadlineMs);
    return { ...call, json: JSON.parse(call.stdout) as Record<string, unknown> };
  }

  async text(args: readonly string[], deadlineMs = 120_000, exitCode = 0): Promise<AxiText> {
    const call = await this.call([...args, "--device", this.serial], deadlineMs);
    expect(call.exitCode, `adb-axi ${call.args.join(" ")}\n${call.stdout}${call.stderr}`).toBe(
      exitCode,
    );
    return {
      stdout: call.stdout,
      data: decode(call.stdout.trimEnd()) as Record<string, unknown>,
    };
  }

  private async call(full: readonly string[], deadlineMs: number): Promise<Omit<AxiRun, "json">> {
    const result = await exec({ file: this.bin, args: full, env: this.env, deadlineMs });
    const stdout = result.stdout.toString("utf8");
    const stderr = result.stderr.toString("utf8");
    const exitCode = result.kind === "exited" ? result.exitCode : null;
    appendFileSync(
      this.transcript,
      `$ adb-axi ${full.map(quote).join(" ")}\n` +
        `# ${result.kind}, exit ${exitCode ?? "-"}, ${result.durationMs} ms\n` +
        stdout +
        (stderr === "" ? "" : `# stderr\n${stderr}`) +
        "\n",
    );
    if (result.kind !== "exited") {
      throw new Error(`adb-axi ${full.join(" ")} did not exit: ${result.kind}`);
    }
    return { args: full, exitCode, durationMs: result.durationMs, stdout, stderr };
  }

  private async saveDeviceLog(test: string): Promise<void> {
    const result = await exec({
      file: locateAdb(),
      args: ["-s", this.serial, "logcat", "-d", "-t", "2000"],
      deadlineMs: 30_000,
    });
    appendFileSync(
      this.failureLog,
      `# ${test}\n# ${result.kind}\n${result.stdout.toString("utf8")}${result.stderr.toString("utf8")}\n`,
    );
  }

  /**
   * Run one command that must fail with exit 1, in JSON and in TOON, and return the JSON
   * error after checking both formats carry the same fields.
   */
  async fails(
    args: readonly string[],
    code: string,
    options: {
      deadlineMs?: number;
      varies?: readonly string[];
      /** Recreate the failing state before each of the two runs. */
      before?: () => Promise<void>;
    } = {},
  ): Promise<Record<string, unknown>> {
    await options.before?.();
    const run = await this.run(args, options.deadlineMs);
    expect(run.exitCode, `adb-axi ${run.args.join(" ")}\n${run.stdout}${run.stderr}`).toBe(1);
    expect(run.json.code).toBe(code);
    await options.before?.();
    const text = await this.text(args, options.deadlineMs, 1);
    const stable = (data: Record<string, unknown>): Record<string, unknown> =>
      Object.fromEntries(
        Object.entries(data).map(([key, value]) => [
          key,
          options.varies?.includes(key) === true ? typeof value : value,
        ]),
      );
    expect(stable(text.data)).toEqual(stable(run.json));
    return run.json;
  }

  /** One device shell command through adb-axi; its stdout, after checking it exited 0. */
  async sh(command: string): Promise<string> {
    const json = await this.ok(["shell", command]);
    expect(json.exit, command).toBe(0);
    return String(json.stdout);
  }

  /**
   * Plain adb against this device, for what adb-axi must find already done: an install by
   * another tool, a second transport. Logged to the transcript like adb-axi calls.
   */
  async adb(args: readonly string[], deadlineMs = 120_000): Promise<AdbRun> {
    const full = ["-s", this.serial, ...args];
    const result = await exec({ file: locateAdb(), args: full, deadlineMs });
    const stdout = result.stdout.toString("utf8");
    const stderr = result.stderr.toString("utf8");
    const exitCode = result.kind === "exited" ? result.exitCode : null;
    appendFileSync(
      this.transcript,
      `$ adb ${full.map(quote).join(" ")}\n# ${result.kind}, exit ${exitCode ?? "-"}, ${result.durationMs} ms\n${stdout}${stderr}\n`,
    );
    return { exitCode, stdout, stderr };
  }

  /** Run one command that must succeed, and return its JSON. */
  async ok(args: readonly string[], deadlineMs?: number): Promise<Record<string, unknown>> {
    const run = await this.run(args, deadlineMs);
    expect(run.exitCode, `adb-axi ${run.args.join(" ")}\n${run.stdout}${run.stderr}`).toBe(0);
    return run.json;
  }

  /** Send the probe one action through its explicit intent, with optional `am` extras. */
  async probe(action: string, extras = ""): Promise<void> {
    const json = await this.ok([
      "shell",
      `am start -n ${PKG}/.MainActivity --es probe ${action}${extras === "" ? "" : ` ${extras}`}`,
    ]);
    expect(json.exit).toBe(0);
  }

  /** Wait for a log line after a mark, and return its message. */
  async waitLog(regex: string, since: string, timeout = "30s"): Promise<string> {
    const json = await this.ok(["wait", "log", regex, "--since", since, "--timeout", timeout]);
    return (json.match as { message: string }).message;
  }

  /** Record a mark and return the device time it holds, as logcat's `-T` reads it. */
  async mark(name: string): Promise<string> {
    const json = await this.ok(["logs", "mark", name]);
    const time = /-> (\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}) on /.exec(String(json.ok))?.[1];
    expect(time, String(json.ok)).toBeDefined();
    return time ?? "";
  }

  async focused(): Promise<string | undefined> {
    const json = await this.ok(["shell", "dumpsys window displays | grep mFocusedApp= || true"]);
    expect(typeof json.stdout).toBe("string");
    return /mFocusedApp=.*? u\d+ (\S+\/\S+) t\d+/.exec(json.stdout as string)?.[1];
  }

  async waitFocused(accept: (component: string) => boolean): Promise<string> {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const component = await this.focused();
      if (component !== undefined && accept(component)) return component;
      expect(Date.now(), `focused app is still ${component ?? "none"}`).toBeLessThan(deadline);
    }
  }

  async pidsOf(name: string): Promise<number[]> {
    const json = await this.ok([
      "shell",
      `ps -A -o PID,NAME | awk '$2 == "${name}" || $2 == "[${name}]" {print}'`,
    ]);
    expect(typeof json.stdout).toBe("string");
    return (json.stdout as string)
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .filter((columns) => columns[1] === name || columns[1] === `[${name}]`)
      .map((columns) => Number(columns[0]));
  }

  /** Count probe crashes since a mark and return the CLI's crash payload, or {} if absent. */
  async crashes(since: string): Promise<{ count: number; crash: Record<string, unknown> }> {
    const json = await this.ok(["logs", "crash", "--pkg", PKG, "--since", since]);
    const count = /^(\d+) since /.exec(String(json.crashes))?.[1];
    expect(count, String(json.crashes)).toBeDefined();
    return { count: Number(count), crash: (json.crash ?? {}) as Record<string, unknown> };
  }
}

/**
 * Suppress Android's crash and ANR dialogs for one test file, so a dialog never takes the
 * foreground from the next check, and restore the original setting afterwards.
 */
export function hideErrorDialogs(axi: Axi): void {
  let original: string | undefined;
  beforeAll(async () => {
    const value = (await axi.sh("settings get global hide_error_dialogs")).trim();
    expect(value).toMatch(/^(null|\d+)$/);
    original = value;
    await axi.sh("settings put global hide_error_dialogs 1");
  });
  afterAll(async () => {
    if (original === undefined) return;
    await axi.sh(
      original === "null"
        ? "settings delete global hide_error_dialogs"
        : `settings put global hide_error_dialogs ${original}`,
    );
    expect((await axi.sh("settings get global hide_error_dialogs")).trim()).toBe(original);
  });
}

/** The probe's oracle line, `event=... saved=N volatile=N rows=N restored=B pid=N`. */
export function probeState(message: string): Record<string, string> {
  return Object.fromEntries(
    message
      .split(" ")
      .map((pair) => pair.split("="))
      .filter((pair): pair is [string, string] => pair.length === 2),
  );
}

function quote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
}
