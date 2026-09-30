import { describe, expect, it } from "vitest";
import { exec, isProcessAlive } from "../../src/core/exec.js";

const node = process.execPath;
const MARGIN_MS = 750;

describe("exec", () => {
  it("returns the exit code and keeps stdout and stderr apart", async () => {
    const result = await exec({
      file: node,
      args: ["-e", "process.stdout.write('out'); process.stderr.write('err'); process.exit(4)"],
      deadlineMs: 10_000,
    });
    expect(result).toMatchObject({ kind: "exited", exitCode: 4, signal: null });
    expect(result.stdout.toString()).toBe("out");
    expect(result.stderr.toString()).toBe("err");
  });

  it("passes arguments as an array, never through a shell", async () => {
    const tricky = "a b; echo pwned $(whoami) 'q' \"d\"";
    const result = await exec({
      file: node,
      args: ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", tricky],
      deadlineMs: 10_000,
    });
    expect(JSON.parse(result.stdout.toString())).toEqual([tricky]);
  });

  it("writes input to stdin", async () => {
    const result = await exec({
      file: node,
      args: ["-e", "process.stdin.pipe(process.stdout)"],
      input: "hello",
      deadlineMs: 10_000,
    });
    expect(result.stdout.toString()).toBe("hello");
  });

  it("kills a hung child at the deadline and keeps its partial output", async () => {
    const result = await exec({
      file: node,
      args: ["-e", "process.stdout.write('partial'); setInterval(() => {}, 1000)"],
      deadlineMs: 500,
    });
    expect(result.kind).toBe("timeout");
    expect(result.stdout.toString()).toBe("partial");
    expect(result.durationMs).toBeGreaterThanOrEqual(450);
    expect(result.durationMs).toBeLessThan(500 + MARGIN_MS);
    expect(result.pid).toBeDefined();
    expect(isProcessAlive(result.pid ?? 0)).toBe(false);
  });

  it("kills a child that ignores SIGTERM", async () => {
    const result = await exec({
      file: node,
      args: ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
      deadlineMs: 300,
    });
    expect(result.kind).toBe("timeout");
    expect(isProcessAlive(result.pid ?? 0)).toBe(false);
  });

  it("reports a missing executable as a spawn error", async () => {
    const result = await exec({ file: "adb-axi-no-such-tool", args: [], deadlineMs: 5000 });
    expect(result.kind).toBe("spawn-error");
    if (result.kind === "spawn-error") {
      expect(result.error.message).toContain("ENOENT");
    }
  });

  it("does not wait for a grandchild that keeps the pipes open", async () => {
    const result = await exec({
      file: "/bin/sh",
      args: ["-c", "sleep 3 & echo started"],
      deadlineMs: 10_000,
    });
    expect(result).toMatchObject({ kind: "exited", exitCode: 0 });
    expect(result.stdout.toString()).toBe("started\n");
    expect(result.durationMs).toBeLessThan(1500);
  });
});
