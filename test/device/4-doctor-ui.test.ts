import { spawn, type ChildProcess } from "node:child_process";
import { describe, expect, test } from "vitest";
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

async function stop(reader: ChildProcess): Promise<void> {
  if (reader.exitCode !== null || reader.signalCode !== null) return;
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
      const reader = spawn(locateAdb(), ["-s", axi.serial, transport, "uiautomator", "events"], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      let output = "";
      reader.stdout?.on("data", (data: Buffer) => {
        output += data.toString();
      });
      reader.stderr?.on("data", (data: Buffer) => {
        output += data.toString();
      });
      reader.on("exit", (code, signal) =>
        console.error("READER_EXIT", transport, code, signal, output),
      );
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
      } finally {
        console.error(
          "READER_FINAL",
          transport,
          reader.pid,
          reader.exitCode,
          reader.signalCode,
          output,
        );
        console.error(
          "READER_DEVICE",
          await axi.adb([
            "shell",
            "ps -A -o PID,ARGS; dumpsys accessibility; logcat -d -t 100 -s UiAutomation UiAutomationConnection AndroidRuntime",
          ]),
        );
        await stop(reader);
      }
      expect(await uiautomation("free")).toEqual({ uiautomation: "free" });
    });
  }
});
