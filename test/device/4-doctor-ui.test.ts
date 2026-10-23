import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, closeSync, openSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, inject, test } from "vitest";
import { locateAdb } from "../../src/adb/locate.js";
import { Axi } from "./support.js";

const axi = new Axi(import.meta.filename);

/** Poll `doctor ui` until UiAutomation reaches `state`, and return that report. */
async function uiautomation(state: "free" | "in use"): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const run = await axi.run(["doctor", "ui"]);
    if (run.json.uiautomation === state) return run.json;
    expect(Date.now(), JSON.stringify(run.json)).toBeLessThan(deadline);
  }
}

function startReader(transport: "shell" | "exec-out"): ChildProcess {
  const trace = join(inject("device").transcripts, `4-doctor-ui.${transport}.reader`);
  const status = (message: string): void => {
    appendFileSync(`${trace}.txt`, `${new Date().toISOString()} ${message}\n`);
  };
  const started = performance.now();
  const stdout = openSync(`${trace}.stdout.txt`, "a");
  try {
    const stderr = openSync(`${trace}.stderr.txt`, "a");
    try {
      // Files preserve the reader's output without pipe backpressure or per-event callbacks.
      const reader = spawn(locateAdb(), ["-s", axi.serial, transport, "uiautomator", "events"], {
        stdio: ["ignore", stdout, stderr],
      });
      status(
        `started adb -s ${axi.serial} ${transport} uiautomator events, host pid ${reader.pid}`,
      );
      reader.once("error", (error) => {
        status(`spawn error: ${error.message}`);
      });
      reader.once("exit", (code, signal) => {
        status(
          `exit ${code ?? "-"}, signal ${signal ?? "-"}, ${Math.round(performance.now() - started)} ms`,
        );
      });
      return reader;
    } finally {
      closeSync(stderr);
    }
  } finally {
    closeSync(stdout);
  }
}

async function stop(reader: ChildProcess): Promise<void> {
  if (reader.pid === undefined || reader.exitCode !== null || reader.signalCode !== null) return;
  const exited = new Promise((resolve) => reader.once("exit", resolve));
  reader.kill();
  await exited;
}

// Leaked and wedged holders need the Android CLI's instrumentation server, which CI does
// not have; README.md lists that check as a local step.
describe("doctor ui", () => {
  test("reports UiAutomation free when nothing holds it", async () => {
    const run = await axi.run(["doctor", "ui"]);
    expect(run.exitCode).toBe(0);
    expect(run.json).toEqual({ uiautomation: "free" });
    const text = await axi.text(["doctor", "ui"]);
    expect(text.stdout).toBe("uiautomation: free\n");
    expect(text.data).toEqual(run.json);
    const fix = await axi.ok(["doctor", "ui", "--fix"]);
    expect(fix).toEqual({ ok: `doctor ui ${axi.serial} -> uiautomation free (no-op)`, noop: true });
  });

  for (const transport of ["shell", "exec-out"] as const) {
    test(`a live adb ${transport} uiautomator reader is named, protected from --fix, and gone once it ends`, async () => {
      const reader = startReader(transport);
      try {
        const report = await uiautomation("in use");
        const why = `adb ${transport} uiautomator pid ${reader.pid} on the host`;
        expect(report).toEqual({
          uiautomation: "in use",
          holders: [
            {
              pid: expect.any(Number) as number,
              holder: "uiautomator (adb uiautomator)",
              state: "live",
              why,
            },
          ],
          help: [`Wait for \`adb ${transport} uiautomator\` (pid ${reader.pid}) to finish`],
        });
        const devicePid = (report.holders as { pid: number }[])[0]?.pid ?? 0;
        expect(
          (await axi.sh(`ps -A -o PID,NAME | awk '$1 == ${devicePid} {print $2}'`)).trim(),
        ).toBe("uiautomator");

        const fix = await axi.fails(["doctor", "ui", "--fix"], "HOLDER_PROTECTED");
        expect(fix).toMatchObject({
          error: "uiautomator (adb uiautomator) is live and --fix left it alone",
          protected: [{ pid: devicePid, holder: "uiautomator (adb uiautomator)", why }],
        });
        expect(reader.exitCode).toBeNull();
      } catch (error) {
        // Capture the holder before cleanup removes the process the failed report may have missed.
        await axi.adb(["shell", "ps -A -o PID,ARGS; dumpsys accessibility"], 5_000);
        throw error;
      } finally {
        await stop(reader);
      }
      expect(await uiautomation("free")).toEqual({ uiautomation: "free" });
    });
  }
});
