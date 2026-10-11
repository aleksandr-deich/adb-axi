import { appendFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { expect, inject } from "vitest";
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

export interface AxiRun {
  args: readonly string[];
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  /** stdout parsed as JSON; every call passes `--json`. */
  json: Record<string, unknown>;
}

/**
 * The installed adb-axi bound to one emulator. Every call names the device by serial, asks
 * for JSON and is appended to this test file's transcript.
 */
export class Axi {
  readonly serial: string;
  private readonly bin: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly transcript: string;

  constructor(testFile: string) {
    const device = inject("device");
    this.serial = device.serial;
    this.bin = device.bin;
    this.env = { ...process.env, ADB_AXI_HOME: device.home };
    this.transcript = join(device.transcripts, `${basename(testFile, ".test.ts")}.txt`);
  }

  /** Run one command; the exit code is the caller's to check. */
  async run(args: readonly string[], deadlineMs = 120_000): Promise<AxiRun> {
    const full = [...args, "--device", this.serial, "--json"];
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
    return {
      args: full,
      exitCode,
      durationMs: result.durationMs,
      stdout,
      stderr,
      json: JSON.parse(stdout) as Record<string, unknown>,
    };
  }

  /** Run one command that must succeed, and return its JSON. */
  async ok(args: readonly string[], deadlineMs?: number): Promise<Record<string, unknown>> {
    const run = await this.run(args, deadlineMs);
    expect(run.exitCode, `adb-axi ${run.args.join(" ")}\n${run.stdout}${run.stderr}`).toBe(0);
    return run.json;
  }

  /** Send the probe one action through its explicit intent. */
  async probe(action: string): Promise<void> {
    const json = await this.ok(["shell", `am start -n ${PKG}/.MainActivity --es probe ${action}`]);
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

  /** How many crashes `logs crash` counts for the probe since a mark, and the first one. */
  async crashes(since: string): Promise<{ count: number; crash: Record<string, unknown> }> {
    const json = await this.ok(["logs", "crash", "--pkg", PKG, "--since", since]);
    const count = /^(\d+) since /.exec(String(json.crashes))?.[1];
    expect(count, String(json.crashes)).toBeDefined();
    return { count: Number(count), crash: (json.crash ?? {}) as Record<string, unknown> };
  }
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
