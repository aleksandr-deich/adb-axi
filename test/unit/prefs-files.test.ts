import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  decodePrefsUtf8,
  PREFS_LIST_SCRIPT,
  prefsInventory,
  prefsReadScript,
  prefsSnapshot,
} from "../../src/commands/data/prefs-files.js";
import { parsePreferences } from "../../src/commands/data/prefs-xml.js";

const captured = readFileSync(new URL("../fixtures/prefs/probe-settings.xml", import.meta.url));

describe("SharedPreferences file boundaries", () => {
  test("counts backup-only names and reads Android's recovery source without changing bytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "adb-axi-prefs-recovery-"));
    try {
      const prefs = join(dir, "shared_prefs");
      mkdirSync(prefs);
      writeFileSync(join(prefs, "a.xml"), captured);
      writeFileSync(join(prefs, "b.xml.bak"), captured);
      const listing = (): string[] =>
        prefsInventory(execFileSync("sh", ["-c", PREFS_LIST_SCRIPT], { cwd: dir }));
      expect(listing()).toEqual(["a.xml", "b.xml"]);
      const read = () =>
        prefsSnapshot(execFileSync("sh", ["-c", prefsReadScript("b.xml")], { cwd: dir }), "b.xml");
      expect(read()).toEqual({ source: "b.xml.bak", xml: captured.toString("utf8") });
      const partial = "<map><string";
      writeFileSync(join(prefs, "b.xml"), partial);
      expect(listing()).toEqual(["a.xml", "b.xml"]);
      expect(parsePreferences(read().xml)).toContainEqual({
        key: "owner",
        type: "string",
        value: "primary",
      });
      expect(readFileSync(join(prefs, "a.xml"))).toEqual(captured);
      expect(readFileSync(join(prefs, "b.xml.bak"))).toEqual(captured);
      expect(readFileSync(join(prefs, "b.xml"), "utf8")).toBe(partial);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reports hostile device names as invalid output rather than a --file usage error", () => {
    expect(() => prefsInventory(Buffer.from("shared_prefs/a\\b.xml\0"))).toThrow(
      expect.objectContaining({
        code: "INVALID_OUTPUT",
        message: "SharedPreferences directory contains an unsupported file name",
      }),
    );
  });

  test("refuses invalid UTF-8 instead of substituting a replacement value", () => {
    expect(() => decodePrefsUtf8(Buffer.from([0xc3, 0x28]))).toThrow(
      expect.objectContaining({ code: "INVALID_OUTPUT" }),
    );
    expect(decodePrefsUtf8(Buffer.from("\ufffd", "utf8"))).toBe("\ufffd");
  });
});
