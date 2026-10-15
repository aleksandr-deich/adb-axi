import { describe, expect, test } from "vitest";
import { Axi, DEBUG_APK, PKG, probeState } from "./support.js";

const axi = new Axi(import.meta.filename);
const formats = ["json", "toon"] as const;
type Format = (typeof formats)[number];

async function command(args: string[], format: Format): Promise<Record<string, unknown>> {
  return format === "json" ? axi.ok(args) : axi.text(args);
}

function noop(data: Record<string, unknown>, format: Format, expected: boolean): void {
  if (format === "json") expect(data.noop).toBe(expected);
  expect(String(data.ok).endsWith(" (no-op)")).toBe(expected);
}

async function seed(): Promise<void> {
  await axi.mark("seed");
  await axi.ok(["app", "start", PKG, "--fresh"]);
  await axi.probe("inc");
  await axi.probe("write");
  const state = probeState(await axi.waitLog("event=write saved=1 volatile=1 rows=1 ", "seed"));
  expect(state).toMatchObject({ saved: "1", volatile: "1", rows: "1" });
  expect(await axi.pidsOf(PKG)).toEqual([Number(state.pid)]);
}

async function gone(): Promise<void> {
  expect(await axi.pidsOf(PKG)).toEqual([]);
  const activity = await axi.ok([
    "shell",
    `dumpsys activity processes | grep -E 'ProcessRecord.*:${PKG}/' || true`,
  ]);
  expect(activity.stdout).toBe("");
}

describe("ordinary installed probe lifecycle", () => {
  test("keep-data uninstall and absent no-op preserve the Room row across reinstall", async () => {
    for (const format of formats) {
      await axi.ok(["app", "install", DEBUG_APK, "--clean-data"]);
      await seed();
      const removed = await command(["app", "uninstall", PKG, "--keep-data"], format);
      noop(removed, format, false);
      expect(removed.ok).toBe(`uninstall ${PKG} -> removed with data kept`);
      expect((await axi.ok(["shell", `pm path --user 0 ${PKG} || true`])).stdout).toBe("");
      await gone();
      expect(await command(["app", "info", PKG], format)).toEqual({
        app: { package: PKG, installed: false },
      });
      const absent = await command(["app", "uninstall", PKG], format);
      noop(absent, format, true);
      expect(absent.ok).toBe(`uninstall ${PKG} -> already not installed (no-op)`);
      const installed = await command(["app", "install", DEBUG_APK], format);
      expect(installed.ok).toBe(`install ${PKG} -> 1.0 (1) with data kept`);
      expect(installed.install).toMatchObject({ previous: "not installed", debuggable: true });
      await axi.mark("state");
      await axi.ok(["app", "start", PKG, "--fresh"]);
      await axi.probe("state");
      expect(probeState(await axi.waitLog("event=state ", "state")).rows).toBe("1");
      const query = await axi.ok(["data", "db", PKG, "SELECT id, text FROM notes"]);
      expect(query.rows).toEqual([{ id: 1, text: "probe-1" }]);
    }
  });
});
