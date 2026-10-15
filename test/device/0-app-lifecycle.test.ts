import { readdirSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { sharedWithToon } from "../helpers/json.js";
import { Axi, DEBUG_APK, PKG, RELEASE_APK, probeState } from "./support.js";

const axi = new Axi(import.meta.filename);
const formats = ["json", "toon"] as const;
type Format = (typeof formats)[number];

async function command(args: string[], format: Format): Promise<Record<string, unknown>> {
  return format === "json" ? axi.ok(args) : (await axi.text(args)).data;
}

function noop(data: Record<string, unknown>, format: Format, expected: boolean): void {
  if (format === "json") expect(data.noop).toBe(expected);
  expect(String(data.ok).endsWith(" (no-op)")).toBe(expected);
}

async function reset(apk = DEBUG_APK): Promise<void> {
  await axi.ok(["app", "install", apk, "--clean-data"]);
}

async function seed(): Promise<Record<string, string>> {
  await axi.mark("seed");
  await axi.ok(["app", "start", PKG, "--fresh"]);
  await axi.probe("inc");
  await axi.probe("write");
  const state = probeState(await axi.waitLog("event=write saved=1 volatile=1 rows=1 ", "seed"));
  expect(state).toMatchObject({ saved: "1", volatile: "1", rows: "1" });
  expect(await axi.pidsOf(PKG)).toEqual([Number(state.pid)]);
  return state;
}

async function stateAfterStart(): Promise<Record<string, string>> {
  await axi.mark("state");
  await axi.ok(["app", "start", PKG, "--fresh"]);
  await axi.probe("state");
  return probeState(await axi.waitLog("event=state ", "state"));
}

async function gone(): Promise<void> {
  expect(await axi.pidsOf(PKG)).toEqual([]);
  const activity = await axi.ok([
    "shell",
    `dumpsys activity processes | grep -E 'ProcessRecord.*:${PKG}/' || true`,
  ]);
  expect(activity.stdout).toBe("");
}

async function emptyPrivateFiles(): Promise<void> {
  const files = await axi.ok(["shell", `run-as ${PKG} find . -type f`]);
  expect(files.exit).toBe(0);
  expect(files.stdout).toBe("");
}

async function row(): Promise<void> {
  const query = await axi.ok(["data", "db", PKG, "SELECT id, text FROM notes"]);
  expect(query.rows).toEqual([{ id: 1, text: "probe-1" }]);
}

describe("ordinary installed probe lifecycle", () => {
  test("debug installation matches package-manager facts and replacement preserves the Room row", async () => {
    for (const format of formats) {
      await axi.ok(["app", "uninstall", PKG]);
      const absent = await axi.ok(["shell", `pm path ${PKG} || true`]);
      expect(absent.stdout).toBe("");
      const install = await command(["app", "install", DEBUG_APK], format);
      noop(install, format, false);
      expect(install.ok).toBe(`install ${PKG} -> 1.0 (1) (fresh install)`);
      expect(install.install).toMatchObject({ previous: "not installed", debuggable: true });
      const facts = await axi.ok([
        "shell",
        `dumpsys package ${PKG} | grep -E 'versionCode=|versionName=|pkgFlags=|flags=|User 0:'`,
      ]);
      expect(String(facts.stdout)).toMatch(/versionCode=1\b/);
      expect(String(facts.stdout)).toContain("versionName=1.0");
      expect(String(facts.stdout)).toContain("DEBUGGABLE");
      expect(String(facts.stdout)).toMatch(/User 0:.*installed=true/);
      await seed();
      const replacement = await command(["app", "install", DEBUG_APK], format);
      noop(replacement, format, false);
      expect(replacement.install).toMatchObject({ previous: "1.0 (1)", debuggable: true });
      expect((await stateAfterStart()).rows).toBe("1");
      await row();
    }
  });

  test("if-changed is an actual no-op and clean-data takes precedence and really wipes", async () => {
    for (const format of formats) {
      await reset();
      const before = await seed();
      if (format === "toon") expect(readdirSync(axi.freshHome())).toEqual([]);
      const unchanged = await command(["app", "install", DEBUG_APK, "--if-changed"], format);
      noop(unchanged, format, true);
      expect(unchanged.ok).toBe(
        `install ${PKG} -> already installed (same versionCode and signature) (no-op)`,
      );
      expect(await axi.pidsOf(PKG)).toEqual([Number(before.pid)]);
      await row();
      const cleaned = await command(
        ["app", "install", DEBUG_APK, "--if-changed", "--clean-data"],
        format,
      );
      noop(cleaned, format, false);
      expect(cleaned.install).not.toHaveProperty("shortcut");
      expect(cleaned.ok).toBe(`install ${PKG} -> 1.0 (1) with data wiped`);
      await gone();
      await emptyPrivateFiles();
      expect(await stateAfterStart()).toMatchObject({ saved: "0", volatile: "0", rows: "0" });
      expect((await axi.ok(["data", "db", PKG, "SELECT * FROM notes"])).rows).toEqual([]);
      await seed();
      const cleanOnly = await command(["app", "install", DEBUG_APK, "--clean-data"], format);
      noop(cleanOnly, format, false);
      expect(cleanOnly.ok).toBe(cleaned.ok);
      await gone();
      await emptyPrivateFiles();
      expect(await stateAfterStart()).toMatchObject({ saved: "0", volatile: "0", rows: "0" });
    }
  });

  test("stop removes the real process and a second stop is a no-op", async () => {
    for (const format of formats) {
      await reset();
      const before = await seed();
      const stopped = await command(["app", "stop", PKG], format);
      noop(stopped, format, false);
      expect(String(stopped.ok)).toMatch(
        new RegExp(`^stop ${PKG} -> not running \\(pid ${before.pid} gone after \\d+ ms\\)$`),
      );
      expect(Object.keys(sharedWithToon(stopped))).toEqual(["ok"]);
      await gone();
      expect((await stateAfterStart()).rows).toBe("1");
      await axi.ok(["app", "kill", PKG]);
      await gone();
      expect(
        String((await axi.ok(["shell", `dumpsys package ${PKG} | grep 'User 0:'`])).stdout),
      ).toContain("stopped=false");
      const again = await command(["app", "stop", PKG], format);
      noop(again, format, true);
      expect(again.ok).toBe(`stop ${PKG} -> already not running (no-op)`);
      await gone();
      expect(
        String((await axi.ok(["shell", `dumpsys package ${PKG} | grep 'User 0:'`])).stdout),
      ).toContain("stopped=true");
      expect((await stateAfterStart()).rows).toBe("1");
      await row();
    }
  });

  test("clear debug data removes real files and stops running or already-stopped probes", async () => {
    for (const format of formats) {
      await reset();
      await seed();
      const cleared = await command(["app", "clear", PKG], format);
      noop(cleared, format, false);
      expect(cleared.ok).toBe(`clear ${PKG} -> data cleared, process stopped`);
      expect(sharedWithToon(cleared)).toEqual({
        ok: `clear ${PKG} -> data cleared, process stopped`,
        confirmed_by: ["pm clear", "run-as"],
      });
      await gone();
      await emptyPrivateFiles();
      expect(await stateAfterStart()).toMatchObject({ saved: "0", volatile: "0", rows: "0" });
      await seed();
      await axi.ok(["app", "stop", PKG]);
      await gone();
      await row();
      const stopped = await command(["app", "clear", PKG], format);
      expect(stopped.confirmed_by).toEqual(["pm clear", "run-as"]);
      expect(stopped.ok).toBe(cleared.ok);
      await gone();
      await emptyPrivateFiles();
      expect(await stateAfterStart()).toMatchObject({ saved: "0", volatile: "0", rows: "0" });
      expect((await axi.ok(["data", "db", PKG, "SELECT * FROM notes"])).rows).toEqual([]);
    }
  });

  test("uninstall removes the package, removes data, and an absent package is a no-op", async () => {
    for (const format of formats) {
      await reset();
      await seed();
      const removed = await command(["app", "uninstall", PKG], format);
      noop(removed, format, false);
      expect(removed.ok).toBe(`uninstall ${PKG} -> removed`);
      expect((await axi.ok(["shell", `pm path ${PKG} || true`])).stdout).toBe("");
      await gone();
      const absent = await command(["app", "uninstall", PKG], format);
      noop(absent, format, true);
      expect(absent.ok).toBe(`uninstall ${PKG} -> already not installed (no-op)`);
      expect((await axi.ok(["shell", `pm path ${PKG} || true`])).stdout).toBe("");
      const installed = await command(["app", "install", DEBUG_APK, "--if-changed"], format);
      noop(installed, format, false);
      expect(installed.install).not.toHaveProperty("shortcut");
      expect(installed.install).toMatchObject({ previous: "not installed", debuggable: true });
      expect(await stateAfterStart()).toMatchObject({ saved: "0", volatile: "0", rows: "0" });
      expect((await axi.ok(["data", "db", PKG, "SELECT * FROM notes"])).rows).toEqual([]);
    }
  });

  test("keep-data uninstall and absent no-op preserve the Room row across reinstall", async () => {
    for (const format of formats) {
      await reset();
      await seed();
      const removed = await command(["app", "uninstall", PKG, "--keep-data"], format);
      noop(removed, format, false);
      expect(removed.ok).toBe(`uninstall ${PKG} -> removed with data kept`);
      expect((await axi.ok(["shell", `pm path ${PKG} || true`])).stdout).toBe("");
      await gone();
      const absent = await command(["app", "uninstall", PKG], format);
      noop(absent, format, true);
      expect(absent.ok).toBe(`uninstall ${PKG} -> already not installed (no-op)`);
      const installed = await command(["app", "install", DEBUG_APK], format);
      expect(installed.ok).toBe(`install ${PKG} -> 1.0 (1) with data kept`);
      expect(installed.install).toMatchObject({ previous: "not installed", debuggable: true });
      expect((await stateAfterStart()).rows).toBe("1");
      await row();
    }
  });

  test("missing-package lifecycle commands fail before creating any process", async () => {
    const missing = `${PKG}.missing`;
    expect((await axi.ok(["shell", `pm path ${missing} || true`])).stdout).toBe("");
    for (const action of ["start", "stop", "clear", "kill", "restore", "death"]) {
      const json = await axi.run(["app", action, missing]);
      expect(json.exitCode).toBe(1);
      expect(json.json).toMatchObject({
        code: "APP_NOT_INSTALLED",
        error: `${missing} is not installed on this device`,
      });
      expect(json.json.help).toEqual([
        `Run \`adb-axi app list --grep missing --device ${axi.serial}\` to find the package`,
        `Run \`adb-axi app install <apk> --device ${axi.serial}\` to install it`,
      ]);
      const text = await axi.text(["app", action, missing], 120_000, 1);
      expect(text.data).toEqual(json.json);
      expect(await axi.pidsOf(missing)).toEqual([]);
      expect((await axi.ok(["shell", `pm path ${missing} || true`])).stdout).toBe("");
    }
  });

  test("clear release data is confirmed by package manager without claiming run-as evidence", async () => {
    for (const format of formats) {
      await reset(RELEASE_APK);
      await seed();
      const cleared = await command(["app", "clear", PKG], format);
      expect(cleared.ok).toBe(`clear ${PKG} -> data cleared, process stopped`);
      expect(cleared.confirmed_by).toEqual(["pm clear"]);
      await gone();
      expect(await stateAfterStart()).toMatchObject({ saved: "0", volatile: "0", rows: "0" });
      const denied = await axi.run(["data", "db", PKG]);
      expect(denied.exitCode).toBe(1);
      expect(denied.json.code).toBe("APP_NOT_DEBUGGABLE");
    }
  });
});
