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

describe("synthetic API 29/30 samples", () => {
  const SYNTHETIC_DIR = join(FIXTURES_DIR, "synthetic");
  const levels = readdirSync(SYNTHETIC_DIR).sort();

  interface SyntheticIndex {
    synthetic: boolean;
    samples: { file: string; argv: string[]; synthetic: boolean; source: string }[];
  }
  const index = (level: string): SyntheticIndex =>
    JSON.parse(readFileSync(join(SYNTHETIC_DIR, level, "index.json"), "utf8")) as SyntheticIndex;

  it("covers the two API levels without logcat --uid", () => {
    expect(levels).toEqual(["29", "30"]);
  });

  it.each(levels)("indexes every file in synthetic/%s, and nothing more", (level) => {
    const onDisk = readdirSync(join(SYNTHETIC_DIR, level))
      .filter((name) => name !== "index.json")
      .sort();
    expect(
      index(level)
        .samples.map((s) => s.file)
        .sort(),
    ).toEqual(onDisk);
  });

  it.each(levels)("marks every sample of synthetic/%s synthetic, with its AOSP source", (level) => {
    expect(index(level).synthetic).toBe(true);
    for (const sample of index(level).samples) {
      expect(sample.synthetic, sample.file).toBe(true);
      expect(sample.source, sample.file).toMatch(/^AOSP platform\/\S+ android-1[01]\.0\.0_r1 \S+/);
      expect(sample.argv.slice(0, 2), sample.file).toEqual(["adb", "-s"]);
    }
  });

  it.each(levels)("names every file of synthetic/%s in EVIDENCE.md", (level) => {
    const section = evidence.slice(evidence.indexOf("## Synthetic API 29/30 samples"));
    const missing = index(level).samples.filter((s) => !section.includes(`\`${s.file}\``));
    expect(missing).toEqual([]);
  });
});
