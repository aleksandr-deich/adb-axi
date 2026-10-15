import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { Axi } from "./support.js";

const axi = new Axi(import.meta.filename);

function doctorHint(): string {
  return `Run \`adb-axi doctor --device ${axi.serial}\` to check the device; it may be hung, which a longer deadline does not fix (\`adb -s ${axi.serial} reconnect\`, or restart the emulator)`;
}

describe("shell on a real device shell", () => {
  test("exit codes and both streams come back as the device produced them", async () => {
    expect(await axi.ok(["shell", "--", "echo", "a", "b", "c"])).toEqual({
      exit: 0,
      stdout: "a b c",
    });
    expect(await axi.ok(["shell", "--", "echo", "--json"])).toEqual({ exit: 0, stdout: "--json" });
    expect(await axi.ok(["shell", "true"])).toEqual({ exit: 0, stdout: "" });
    expect(await axi.ok(["shell", "echo out; echo err >&2"])).toEqual({
      exit: 0,
      stdout: "out",
      stderr: "err",
    });
    expect(await axi.fails(["shell", "echo out; echo err >&2; exit 3"], "REMOTE_EXIT")).toEqual({
      error: "remote command exited 3",
      code: "REMOTE_EXIT",
      exit: 3,
      stdout: "out",
      stderr: "err",
    });
    expect(await axi.fails(["shell", "exit 5"], "REMOTE_EXIT")).toEqual({
      error: "remote command exited 5",
      code: "REMOTE_EXIT",
      exit: 5,
      stderr: "",
    });
    for (const [line, exit] of [
      ["error: device unauthorized.", 4],
      ["adb: error: failed to check server version: cannot connect to daemon", 2],
      ["error: no devices/emulators found", 1],
    ] as const) {
      const command = `echo out; echo '${line}' >&2; exit ${exit}`;
      expect(await axi.fails(["shell", command], "REMOTE_EXIT")).toEqual({
        error: `remote command exited ${exit}`,
        code: "REMOTE_EXIT",
        exit,
        stdout: "out",
        stderr: line,
      });
    }
    const lines = await axi.text(["shell", "printf 'a\\nb\\n'"]);
    expect(lines.stdout).toBe("exit: 0\nstdout[2]:\n  - a\n  - b\n");
    expect(await axi.ok(["shell", "printf 'a\\nb\\n'"])).toEqual({ exit: 0, stdout: "a\nb" });
  });

  test("long output stops at 50 lines or 4 kB, --full writes all of it, and failures keep both streams apart", async () => {
    const seq = await axi.ok(["shell", "seq 1 120", "--timeout", "20s"]);
    expect((seq.stdout as string).split("\n")).toEqual(
      Array.from({ length: 50 }, (_, i) => String(i + 1)),
    );
    expect(seq.shown).toBe("50 of 120 lines");
    expect(seq.help).toEqual([
      `Run \`adb-axi shell --device ${axi.serial} --timeout 20s --full -- 'seq 1 120'\` to write the complete output to a file`,
    ]);

    const wide = await axi.ok(["shell", "head -c 5000 /dev/zero | tr '\\0' x"]);
    expect(wide.stdout).toBe("x".repeat(4096));
    expect(wide.shown).toBe("1 of 1 lines, cut at 4096 of 5000 bytes");

    const runs = await Promise.all([
      axi.ok(["shell", "seq 1 120", "--full"]),
      axi.ok(["shell", "seq 1 120", "--full"]),
    ]);
    expect(runs[0].full).not.toBe(runs[1].full);
    for (const run of runs) {
      expect(run).not.toHaveProperty("help");
      expect(readFileSync(String(run.full), "utf8").trimEnd().split("\n")).toHaveLength(120);
    }

    const failed = await axi.run(["shell", "seq 1 60; seq 1 70 >&2; exit 7", "--full"]);
    expect(failed.exitCode).toBe(1);
    expect(failed.json).toMatchObject({
      code: "REMOTE_EXIT",
      exit: 7,
      shown: "50 of 60 lines",
      stderr_shown: "50 of 70 lines",
    });
    const written = (path: unknown): string[] =>
      readFileSync(String(path), "utf8").trimEnd().split("\n");
    expect(written(failed.json.full)).toHaveLength(60);
    expect(written(failed.json.stderr_full)).toHaveLength(70);
  });

  test("a command past its deadline is killed with its partial output, and the default deadline is 15 s", async () => {
    const run = await axi.run([
      "shell",
      "echo starting; echo waiting >&2; sleep 30",
      "--timeout",
      "2s",
    ]);
    expect(run.exitCode).toBe(1);
    expect(run.json).toEqual({
      error: "running the command did not finish before the 2 s deadline",
      code: "TIMEOUT",
      step: "running the command",
      stdout: "starting",
      stderr: "waiting",
      help: [
        doctorHint(),
        "Run the same command with a longer `--timeout`, for example `--timeout 60s`",
      ],
    });
    expect(run.durationMs).toBeLessThan(2_000 + 2_000);

    const withFull = await axi.run(["shell", "seq 1 80; sleep 30", "--timeout", "2s", "--full"]);
    expect(withFull.json).toMatchObject({ code: "TIMEOUT", shown: "50 of 80 lines" });
    expect(readFileSync(String(withFull.json.full), "utf8").trimEnd().split("\n")).toHaveLength(80);
    expect(String(withFull.json.help)).not.toContain("--full");

    const standard = await axi.run(["shell", "sleep 20"]);
    expect(standard.exitCode).toBe(1);
    expect(standard.json.error).toBe("running the command did not finish before the 15 s deadline");
    expect(standard.durationMs).toBeGreaterThanOrEqual(15_000);
    expect(standard.durationMs).toBeLessThan(15_000 + 3_000);
  });
});
