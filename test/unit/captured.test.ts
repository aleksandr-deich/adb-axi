import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURES_DIR } from "../fake-adb/harness.js";

const CAPTURED_DIR = join(FIXTURES_DIR, "captured");
const APK_DIR = join(FIXTURES_DIR, "apk");
const evidence = readFileSync(join(FIXTURES_DIR, "EVIDENCE.md"), "utf8");
const groups = readdirSync(CAPTURED_DIR).sort();

interface Index {
  captures: { file: string; argv: string[]; exitCode: number | null }[];
}

function readIndex(group: string): Index {
  return JSON.parse(readFileSync(join(CAPTURED_DIR, group, "index.json"), "utf8")) as Index;
}

describe("captured real-device output", () => {
  it("holds the host captures and both emulator API levels", () => {
    expect(groups).toEqual(["35", "37", "host"]);
  });

  it.each(groups)("indexes every file in captured/%s, and nothing more", (group) => {
    const onDisk = readdirSync(join(CAPTURED_DIR, group))
      .filter((name) => name !== "index.json")
      .sort();
    const indexed = readIndex(group)
      .captures.map((c) => c.file)
      .sort();
    expect(onDisk).toEqual(indexed);
  });

  it.each(groups)("names every file of captured/%s in EVIDENCE.md", (group) => {
    const missing = readdirSync(join(CAPTURED_DIR, group)).filter(
      (name) => !evidence.includes(`\`${name}\``),
    );
    expect(missing).toEqual([]);
  });

  it.each(groups.filter((g) => g !== "host"))(
    "sends every device call of captured/%s with an explicit -s <serial>",
    (group) => {
      const unaddressed = readIndex(group).captures.filter(
        (c) => c.argv[1] !== "-s" || c.argv[2] === undefined,
      );
      expect(unaddressed).toEqual([]);
    },
  );

  it("keeps the host's adb key out of the captures", () => {
    for (const group of groups) {
      for (const name of readdirSync(join(CAPTURED_DIR, group))) {
        if (name.endsWith(".bin")) continue;
        const text = readFileSync(join(CAPTURED_DIR, group, name), "utf8");
        expect(text, `${group}/${name}`).not.toMatch(/adb\.pubkey\]: \[(?!<redacted>\])/);
      }
    }
  });
});

describe("probe app APKs", () => {
  it.each(["probe-debug.apk", "probe-release.apk"])(
    "commits %s as a zip named in EVIDENCE.md",
    (name) => {
      const path = join(APK_DIR, name);
      expect(existsSync(path)).toBe(true);
      // Local file header signature of a zip archive.
      expect(readFileSync(path).subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
      expect(evidence).toContain(`\`${name}\``);
    },
  );
});
