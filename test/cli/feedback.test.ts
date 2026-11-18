import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeAdb, type FakeAdb } from "../fake-adb/harness.js";
import { ROOT, runCli } from "../helpers/run.js";

/** The issue form the link must prefill; its field ids and dropdown text are the contract. */
const FORM = readFileSync(join(ROOT, ".github", "ISSUE_TEMPLATE", "agent-report.yml"), "utf8");
const VERSION = (
  JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }
).version;

let fake: FakeAdb | undefined;
let dir: string | undefined;
afterEach(() => {
  fake?.cleanup();
  fake = undefined;
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function host(): FakeAdb {
  fake = createFakeAdb("devices-empty.json");
  return fake;
}

function reportFile(text: string): string {
  dir = mkdtempSync(join(tmpdir(), "adb-axi-feedback-"));
  const path = join(dir, "report.md");
  writeFileSync(path, text);
  return path;
}

describe("adb-axi feedback", () => {
  it("prints the report questions with no arguments", async () => {
    const f = host();
    const run = await runCli(["feedback", "--json"], f.env);
    expect(run.exitCode).toBe(0);
    const data = JSON.parse(run.stdout) as Record<string, unknown>;
    const text = [data.brief, ...(data.cover as string[]), data.leave_out].join("\n");
    for (const phrase of [
      "Write a short factual report for its author, using only what actually happened; no guessing, no praise.",
      "the task in one line",
      "every adb-axi command you ran and whether it worked, with exact errors",
      "every raw adb command you ran instead and why",
      "anywhere the output or --help was unclear or made you retry",
      "anything on the device neither tool made easy",
      "Leave out source code, file paths, package names and device serials, and keep it under 3,000 characters.",
    ]) {
      expect(text).toContain(phrase);
    }
    expect((data.help as string[]).join("\n")).toContain("adb-axi feedback --agent");
    expect(f.calls()).toEqual([]);
  });

  it("turns a multi-line markdown report into a link that fills every form field", async () => {
    const f = host();
    const report = [
      "## Task",
      "Check that an app keeps its draft after process death.",
      "",
      "## Commands",
      "- `adb-axi app death` worked: restored -> foreground",
      '- `adb-axi logs crash` printed "0 crashes" & exit 0 (100% clean)',
      "",
      "## Unclear",
      "Nothing; the --help was enough. Ünïcode – ok? #1 +plus",
    ].join("\n");
    const run = await runCli(
      [
        "feedback",
        "--agent",
        "Claude Code with Opus 5.5",
        "--device-kind",
        "phone",
        "--title",
        "draft survives process death",
        "--report",
        reportFile(report),
        "--json",
      ],
      f.env,
    );
    expect(run.exitCode).toBe(0);
    const url = new URL((JSON.parse(run.stdout) as { url: string }).url);
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://github.com/aleksandr-deich/adb-axi/issues/new",
    );
    for (const id of ["agent", "version", "device", "report"]) {
      expect(FORM).toContain(`id: ${id}\n`);
    }
    expect(FORM).toContain("- Physical phone\n");
    expect(FORM).toContain('title: "Agent report: "');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      template: "agent-report.yml",
      title: "Agent report: draft survives process death",
      agent: "Claude Code with Opus 5.5",
      version: VERSION,
      device: "Physical phone",
      report,
    });
    expect(f.calls()).toEqual([]);
  });

  it("refuses a report too long for a link, naming the limit", async () => {
    const f = host();
    const run = await runCli(
      ["feedback", "--agent", "Codex", "--report", reportFile("word ".repeat(2_000)), "--json"],
      f.env,
    );
    expect(run.exitCode).toBe(1);
    const data = JSON.parse(run.stdout) as Record<string, unknown>;
    expect(data).toMatchObject({ code: "REPORT_TOO_LONG", limit: 8_000 });
    expect(data.error).toContain("8,000-character limit");
    expect((data.help as string[]).join("\n")).toContain("from the report");
    expect(run.stdout).not.toContain("https://");
    expect(f.calls()).toEqual([]);
  });
});
