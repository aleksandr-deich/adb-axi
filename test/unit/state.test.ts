import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exec } from "../../src/core/exec.js";
import {
  adbAxiHome,
  deviceStateDir,
  encodeSerial,
  readJson,
  writeFileAtomic,
  writeJsonAtomic,
} from "../../src/core/state.js";

const tempDir = (): string => mkdtempSync(join(tmpdir(), "adb-axi-state-"));

describe("state location", () => {
  it("uses ADB_AXI_HOME when set, otherwise ~/.adb-axi", () => {
    expect(adbAxiHome({ ADB_AXI_HOME: "/x/y" })).toBe("/x/y");
    expect(adbAxiHome({})).toBe(join(homedir(), ".adb-axi"));
    expect(adbAxiHome({ ADB_AXI_HOME: "" })).toBe(join(homedir(), ".adb-axi"));
  });

  it("keys state by serial, one safe directory per serial", () => {
    const env = { ADB_AXI_HOME: "/h" };
    expect(deviceStateDir("emulator-5554", env)).toBe("/h/emulator-5554");
    expect(deviceStateDir("192.168.1.20:5555", env)).toBe("/h/192.168.1.20%3A5555");
    expect(encodeSerial("..")).toBe("%2E%2E");
    expect(encodeSerial("a/b")).toBe("a%2Fb");
    expect(encodeSerial("emulator-5554")).not.toBe(encodeSerial("emulator-5556"));
    expect(() => deviceStateDir("", env)).toThrow(/serial is required/);
  });
});

describe("atomic writes", () => {
  it("writes, creates parent directories and leaves no temporary files", () => {
    const dir = tempDir();
    const path = join(dir, "emulator-5554", "marks.json");
    writeJsonAtomic(path, { "before-save": 1 });
    writeJsonAtomic(path, { "before-save": 2 });
    expect(readJson(path)).toEqual({ "before-save": 2 });
    expect(readdirSync(join(dir, "emulator-5554"))).toEqual(["marks.json"]);
  });

  it("keeps the old content when a write fails", () => {
    const dir = tempDir();
    const path = join(dir, "marks.json");
    writeJsonAtomic(path, { kept: true });
    // A directory where the temporary file's parent should be makes the rename fail.
    expect(() => {
      writeFileAtomic(join(path, "child.json"), "x");
    }).toThrow();
    expect(readJson(path)).toEqual({ kept: true });
    expect(readdirSync(dir)).toEqual(["marks.json"]);
  });

  it("never exposes a torn file to concurrent writers and readers", async () => {
    const dir = tempDir();
    const path = join(dir, "state.json");
    writeJsonAtomic(path, { writer: -1, pad: "" });
    const script = `
      import { writeJsonAtomic } from ${JSON.stringify(new URL("../../src/core/state.ts", import.meta.url).href)};
      const id = Number(process.argv[1]);
      for (let i = 0; i < 200; i++) writeJsonAtomic(${JSON.stringify(path)}, { writer: id, pad: "x".repeat(20000 + id) });
    `;
    const writers = Array.from({ length: 4 }, (_, id) =>
      exec({
        file: process.execPath,
        args: ["--input-type=module", "-e", script, String(id)],
        deadlineMs: 30_000,
      }),
    );
    let reads = 0;
    const writing = { done: false };
    const reader = (async () => {
      while (!writing.done) {
        const value = JSON.parse(readFileSync(path, "utf8")) as { writer: number; pad: string };
        if (value.writer >= 0) expect(value.pad).toHaveLength(20000 + value.writer);
        reads++;
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();
    const results = await Promise.all(writers);
    writing.done = true;
    await reader;
    for (const result of results) {
      expect(result.kind === "exited" ? result.exitCode : result.kind).toBe(0);
    }
    expect(reads).toBeGreaterThan(0);
    expect(readdirSync(dir)).toEqual(["state.json"]);
  });
});

describe("readJson", () => {
  it("returns undefined for a missing file", () => {
    expect(readJson(join(tempDir(), "missing.json"))).toBeUndefined();
  });

  it("names the file when it is not valid JSON", () => {
    const path = join(tempDir(), "bad.json");
    writeFileSync(path, "{nope");
    expect(() => readJson(path)).toThrow(`State file ${path} is not valid JSON`);
  });
});
