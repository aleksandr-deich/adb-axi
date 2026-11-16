import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { presentPreferences } from "../../src/commands/data/prefs-output.js";
import type { PreferenceRow } from "../../src/commands/data/prefs-xml.js";

test("bounded set previews remain arrays and private full output preserves every item", () => {
  const home = mkdtempSync(join(tmpdir(), "adb-axi-prefs-output-"));
  vi.stubEnv("ADB_AXI_HOME", home);
  try {
    const value = Array.from({ length: 100 }, (_, i) => `item${i}-${"x".repeat(20)}`);
    const rows: PreferenceRow[] = [{ key: "tags", type: "set", value }];
    const out = presentPreferences("settings.xml", "settings.xml", rows, "json", "dev.probe", true);
    const preview = (out.rows as PreferenceRow[])[0];
    expect(preview?.type).toBe("set");
    expect(Array.isArray(preview?.value)).toBe(true);
    expect((preview?.value as string[]).length).toBeLessThan(value.length);
    expect(out.shown).toContain("truncated");
    const full = JSON.parse(readFileSync(String(out.full), "utf8")) as { rows: PreferenceRow[] };
    expect(full.rows).toEqual(rows);
  } finally {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  }
});
