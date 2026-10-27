import { describe, expect, it } from "vitest";
import { AdbClient, type AdbCallOptions, type AdbExit } from "../../src/adb/run.js";
import { waitApp } from "../../src/commands/wait/app.js";
import { Deadline } from "../../src/core/deadline.js";
import { AdbAxiError } from "../../src/core/errors.js";
import { openSession } from "../../src/device/session.js";

const SERIAL = "emulator-5554";

/**
 * Answers shell reads from a script, in order, and refuses a call whose deadline has passed, as AdbClient does.
 * The last answer is held until the command deadline has passed, so the final read is always
 * taken after it.
 */
class ScriptedAdb extends AdbClient {
  readonly calls: string[][] = [];
  /** The command deadline's remaining time when each answer was returned. */
  readonly answeredWithMs: number[] = [];
  private readonly commandDeadline: Deadline;
  private readonly answers: AdbExit[];

  constructor(commandDeadline: Deadline, answers: AdbExit[]) {
    super("scripted-adb");
    this.commandDeadline = commandDeadline;
    this.answers = answers;
  }

  override async device(
    serial: string,
    args: readonly string[],
    options: AdbCallOptions,
  ): Promise<AdbExit> {
    this.calls.push(["-s", serial, ...args]);
    const answer = this.answers.shift();
    if (answer === undefined) throw new Error(`no scripted answer for ${args.join(" ")}`);
    while (this.answers.length === 0 && this.commandDeadline.remainingMs() > 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    if (options.deadline.remainingMs() <= 0) {
      throw new AdbAxiError("TIMEOUT", `${options.step} did not finish`);
    }
    this.answeredWithMs.push(this.commandDeadline.remainingMs());
    return answer;
  }
}

function exit(stdout: string, exitCode = 0): AdbExit {
  return { stdout: Buffer.from(stdout), stderr: Buffer.alloc(0), exitCode, durationMs: 0 };
}

function pidofExit(stdout: string): AdbExit {
  return exit(stdout, stdout === "" ? 1 : 0);
}

const PACKAGE =
  "Packages:\n  Package [dev.probe] (abc):\n    appId=10213\n    User 0: installed=true hidden=false\n";
const PS_HEADER = "  PID   UID NAME\n";

describe("wait app", () => {
  it("gives the final observation at the deadline its own short deadline, so a state reached in the last interval is not missed", async () => {
    const timeoutMs = 300;
    const deadline = new Deadline(timeoutMs);
    const adb = new ScriptedAdb(deadline, [
      exit("0\n"),
      exit(PACKAGE),
      exit("package:/data/app/probe/base.apk\n"),
      exit(PS_HEADER),
      exit(`${PS_HEADER} 8235 10213 dev.probe\n`),
      pidofExit("8235\n"),
    ]);
    const result = await waitApp.run({
      spec: waitApp,
      flags: { state: "running" },
      positionals: { pkg: "dev.probe" },
      mode: "toon",
      timeoutMs,
      debug: false,
      deadline,
      adb: () => adb,
      device: openSession(
        {
          serial: SERIAL,
          device: { serial: SERIAL, state: "device", props: {} },
          selectedBy: "flag",
        },
        adb,
        deadline,
        {},
      ),
      env: {},
      hostProcesses: () => Promise.resolve([]),
      isShipped: () => true,
    });
    const waited = result.waited_ms;
    expect(typeof waited).toBe("number");
    expect(result).toEqual({
      ok: `wait app dev.probe -> running after ${String(waited)} ms`,
      waited_ms: waited,
    });
    // The first read saw it stopped; the second, taken once the command deadline had passed, sees it running.
    expect(adb.answeredWithMs.at(-1)).toBeLessThanOrEqual(0);
    expect(adb.calls).toEqual([
      ["-s", SERIAL, "shell", "am get-current-user"],
      ["-s", SERIAL, "shell", "dumpsys package dev.probe"],
      ["-s", SERIAL, "shell", "pm path --user 0 dev.probe"],
      ["-s", SERIAL, "shell", "ps -A -o PID,UID,NAME"],
      ["-s", SERIAL, "shell", "ps -A -o PID,UID,NAME"],
      ["-s", SERIAL, "shell", "pidof 'dev.probe'"],
    ]);
  });
});
