import { describe, expect, it } from "vitest";
import { AdbClient, type AdbCallOptions, type AdbExit } from "../../src/adb/run.js";
import { waitApp } from "../../src/commands/wait/app.js";
import { Deadline } from "../../src/core/deadline.js";
import { AdbAxiError } from "../../src/core/errors.js";

const SERIAL = "emulator-5554";

/**
 * Answers `pidof` from a script, and refuses a call whose deadline has passed, as AdbClient does.
 * The last answer is held until the command deadline has passed, so the final read is always
 * taken after it.
 */
class ScriptedAdb extends AdbClient {
  readonly calls: string[][] = [];
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
    return answer;
  }
}

function pidofExit(stdout: string): AdbExit {
  return {
    stdout: Buffer.from(stdout),
    stderr: Buffer.alloc(0),
    exitCode: stdout === "" ? 1 : 0,
    durationMs: 0,
  };
}

describe("wait app", () => {
  it("gives the final observation at the deadline its own short deadline, so a state reached in the last interval is not missed", async () => {
    const timeoutMs = 300;
    const deadline = new Deadline(timeoutMs);
    const adb = new ScriptedAdb(deadline, [pidofExit(""), pidofExit("8235\n")]);
    const result = await waitApp.run({
      spec: waitApp,
      flags: { state: "running" },
      positionals: { pkg: "dev.probe" },
      mode: "toon",
      timeoutMs,
      debug: false,
      deadline,
      adb: () => adb,
      target: {
        serial: SERIAL,
        device: { serial: SERIAL, state: "device", props: {} },
        selectedBy: "flag",
      },
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
    expect(waited).toBeGreaterThanOrEqual(timeoutMs - 5);
    // The first read saw it stopped; the second, taken once the command deadline had passed, sees it running.
    expect(adb.calls).toEqual([
      ["-s", SERIAL, "shell", "pidof dev.probe"],
      ["-s", SERIAL, "shell", "pidof dev.probe"],
    ]);
  });
});
