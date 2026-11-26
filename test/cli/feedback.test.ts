import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeAdb, type FakeAdb } from "../fake-adb/harness.js";
import { ROOT, runCli } from "../helpers/run.js";

const VERSION = (
  JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }
).version;

let fake: FakeAdb | undefined;
afterEach(() => {
  fake?.cleanup();
  fake = undefined;
});

describe("adb-axi feedback", () => {
  it("prints the plain-text note brief and issues link without reading a device", async () => {
    fake = createFakeAdb("devices-empty.json");
    const run = await runCli(["feedback", "--json"], fake.env);
    expect(run.exitCode).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      brief:
        "You used adb-axi in this session. Write a short, honest plain-text note for its author about what it was like to use: your own impression, not a log of the session. Say it plainly if you did not like it.",
      cover: [
        "the coding agent and model you are, and the adb-axi version below",
        "did you like using adb-axi, or would you rather have used raw adb, and why",
        "what felt good or saved you effort",
        "what was annoying or confusing, or made you go back to raw adb",
        "would you reach for it again next time",
      ],
      leave_out:
        "Leave out source code, file paths, package names and device serials, and keep it under 3,000 characters.",
      version: VERSION,
      issues: "https://github.com/aleksandr-deich/adb-axi/issues",
      help: [
        "Give your user the note and the issues link; they open a new issue there, paste the note, check it and submit. adb-axi posts nothing",
      ],
    });
    expect(run.stdout + run.stderr).not.toContain("issues/new");
    expect(fake.calls()).toEqual([]);
  });

  it("rejects the removed --report flag", async () => {
    const run = await runCli(["feedback", "--report", "x"], process.env);
    expect(run.exitCode).not.toBe(0);
    expect(run.stdout).toContain("unknown flag --report");
  });
});
