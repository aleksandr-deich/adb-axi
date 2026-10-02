import { expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
  writeFileSync: vi.fn(),
}));
vi.mock("node:util", () => ({
  parseArgs: () => ({ values: { serial: ["emulator-test"] } }),
}));
vi.mock("../../src/adb/locate.js", () => ({ locateAdb: () => "adb" }));
vi.mock("../../src/core/exec.js", () => ({ exec: vi.fn() }));

it("fails capture without saving truncated output when exec hits its output limit", async () => {
  const { exec } = await import("../../src/core/exec.js");
  const { writeFileSync } = await import("node:fs");
  vi.mocked(exec).mockResolvedValue({
    kind: "output-limit",
    pid: undefined,
    stdout: Buffer.from("truncated"),
    stderr: Buffer.alloc(0),
    durationMs: 1,
  });

  await expect(import("../device/capture.js")).rejects.toThrow("exceeded its output limit");
  expect(exec).toHaveBeenCalledTimes(1);
  expect(writeFileSync).not.toHaveBeenCalled();
});
