import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  confirmRunning,
  parsePidof,
  psCandidates,
  type AppIdentity,
} from "../../src/android/app-processes.js";
import { FIXTURES_DIR } from "../fake-adb/harness.js";

const LEVELS = ["29", "30", "35"] as const;
type Level = (typeof LEVELS)[number];

function captured(api: Level, file: string): string {
  return readFileSync(join(FIXTURES_DIR, "captured", api, file), "utf8");
}

/** The probe's uid as `pm list packages -U` printed it in the same capture run. */
function probe(api: Level): AppIdentity {
  const index = JSON.parse(captured(api, "index.json")) as {
    processCapture: { probe: { uid: number } };
  };
  return { pkg: "dev.probe", uid: index.processCapture.probe.uid };
}

function pids(api: Level, file: string): number[] {
  const parsed = parsePidof(captured(api, file));
  if (parsed === null) throw new Error(`${api}/${file} is not pidof output`);
  return parsed;
}

describe("app processes on captured ps and pidof", () => {
  it.each(LEVELS)("picks exactly the main and :ui pids pidof printed on API %s", (api) => {
    const app = probe(api);
    const main = pids(api, "processes-running-pidof-main.txt");
    const ui = pids(api, "processes-running-pidof-ui.txt");
    const running = confirmRunning(
      psCandidates(captured(api, "processes-running-ps.txt"), app),
      new Map([
        ["dev.probe", main],
        ["dev.probe:ui", ui],
      ]),
    );
    expect(running).toEqual([
      ...main.map((pid) => ({ pid, name: "dev.probe" })),
      ...ui.map((pid) => ({ pid, name: "dev.probe:ui" })),
    ]);
  });

  it.each([
    ["29", [{ pid: 7107, name: "dev.probe" }]],
    ["30", []],
    ["35", []],
  ] as const)(
    "reads an exiting [dev.probe] row on API %s as the main process, alive only while pidof lists it",
    (api, alive) => {
      const app = probe(api);
      const candidates = psCandidates(captured(api, "processes-exiting-ps.txt"), app);
      const exiting = /^\s*(\d+)\s+\d+\s+\[dev\.probe\]\s*$/m.exec(
        captured(api, "processes-exiting-ps.txt"),
      )?.[1];
      expect(candidates.get("dev.probe")).toEqual(new Set([Number(exiting)]));
      const sample = new Map([["dev.probe", pids(api, "processes-exiting-pidof-main.txt")]]);
      expect(confirmRunning(candidates, sample)).toEqual(alive);
      const empty = new Map([["dev.probe", pids(api, "processes-stopped-pidof-main.txt")]]);
      expect(confirmRunning(candidates, empty)).toEqual([]);
    },
  );

  it.each(LEVELS)("picks no process from the nothing-running table on API %s", (api) => {
    const app = probe(api);
    const candidates = psCandidates(captured(api, "processes-stopped-ps.txt"), app);
    expect(candidates).toEqual(new Map([["dev.probe", new Set()]]));
    const sample = new Map([["dev.probe", pids(api, "processes-stopped-pidof-main.txt")]]);
    expect(confirmRunning(candidates, sample)).toEqual([]);
  });
});
