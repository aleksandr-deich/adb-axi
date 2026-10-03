import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURES_DIR, SCENARIOS_DIR } from "../fake-adb/harness.js";
import type { Scenario } from "../fake-adb/scenario.js";

/** The fixture rows of PRD 11.1, one per evidence ID, that the map must cover. */
const REQUIRED_ROWS = [
  "H1-H4, S3",
  "H5",
  "H6",
  "H7-H9",
  "S1",
  "S2",
  "S4, L4",
  "S5, L5",
  "L7",
  "L9",
  "L10",
  "12.2",
  "Q3",
  "multi-device",
];

interface Row {
  evidence: string;
  scenario: string;
}

/** The rows of the first table in `EVIDENCE.md`: the evidence map itself. */
function evidenceRows(): Row[] {
  const lines = readFileSync(join(FIXTURES_DIR, "EVIDENCE.md"), "utf8").split("\n");
  const start = lines.findIndex((line) => line.startsWith("| Evidence"));
  const rows: Row[] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith("|")) break;
    const [evidence = "", , scenario = ""] = line
      .slice(1, -1)
      .split(" | ")
      .map((cell) => cell.trim());
    rows.push({ evidence, scenario });
  }
  return rows;
}

describe("evidence map", () => {
  const rows = evidenceRows();

  it("has one row for every fixture row of the v0.1 harness", () => {
    expect(rows.map((row) => row.evidence)).toEqual(expect.arrayContaining(REQUIRED_ROWS));
  });

  it("lists every scenario file that replays one of its evidence IDs", () => {
    const text = readFileSync(join(FIXTURES_DIR, "EVIDENCE.md"), "utf8");
    const ids = new Set(rows.flatMap((row) => expandIds(row.evidence)));
    for (const file of readdirSync(SCENARIOS_DIR)) {
      const scenario = JSON.parse(readFileSync(join(SCENARIOS_DIR, file), "utf8")) as Scenario;
      if ((scenario.evidence ?? []).some((id) => ids.has(id))) {
        expect(text, file).toContain(`scenarios/${file}`);
      }
    }
  });
});

/** `H1-H4, S3` as `H1`, `H2`, `H3`, `H4`, `S3`; other IDs as written. */
function expandIds(evidence: string): string[] {
  return evidence.split(",").flatMap((part) => {
    const range = /^([A-Z])(\d+)-[A-Z](\d+)$/.exec(part.trim());
    if (range === null) return [part.trim()];
    const [, letter = "", from = "0", to = "0"] = range;
    const ids: string[] = [];
    for (let n = Number(from); n <= Number(to); n++) ids.push(`${letter}${n}`);
    return ids;
  });
}
