import { describe, expect, test } from "vitest";
import { Axi, DEBUG_APK, PKG, RELEASE_APK } from "./support.js";

const axi = new Axi(import.meta.filename);

async function writePrefs(name: string): Promise<void> {
  const mark = `prefs-${name}`;
  await axi.mark(mark);
  await axi.probe("prefs", `--es name ${name}`);
  expect(await axi.waitLog(`event=prefs name=${name} ok=true`, mark)).toContain("ok=true");
}

async function bytes(name: string): Promise<string> {
  const result = await axi.adb(["shell", `run-as ${PKG} cat shared_prefs/${name}.xml`]);
  expect(result.exitCode).toBe(0);
  return result.stdout;
}

describe("data prefs", () => {
  test("discovers files, preserves every type and empty value without changing XML bytes", async () => {
    await axi.ok(["app", "install", DEBUG_APK, "--clean-data"]);
    expect(await axi.fails(["data", "prefs", PKG], "PREFS_NOT_FOUND")).toMatchObject({ files: [] });
    await axi.ok(["app", "start", PKG]);
    await writePrefs("settings");
    const before = await bytes("settings");
    const result = await axi.ok(["data", "prefs", PKG]);
    expect(result.file).toBe("settings.xml");
    const rows = result.rows as { key: string; type: string; value: unknown }[];
    const normalized = rows
      .map((row) => ({
        ...row,
        value: Array.isArray(row.value) ? (row.value as string[]).slice().sort() : row.value,
      }))
      .sort((a, b) => a.key.localeCompare(b.key));
    expect(normalized).toEqual([
      { key: "count", type: "int", value: -42 },
      { key: "empty", type: "string", value: "" },
      { key: "emptyset", type: "set", value: [] },
      { key: "enabled", type: "boolean", value: true },
      { key: "large", type: "long", value: "9007199254740993" },
      { key: "owner", type: "string", value: "primary" },
      { key: "scale", type: "float", value: 1.25 },
      { key: "tags", type: "set", value: ["", "one", "two<&>"] },
      { key: "text", type: "string", value: 'a<&>" 🚀' },
    ]);
    expect((await axi.text(["data", "prefs", PKG])).data).toEqual(result);
    expect(await bytes("settings")).toBe(before);

    await writePrefs("other");
    const second = await bytes("other");
    const ambiguous = await axi.run(["data", "prefs", PKG]);
    expect(ambiguous.exitCode).toBe(2);
    expect(ambiguous.json).toMatchObject({
      code: "VALIDATION_ERROR",
      files: ["other.xml", "settings.xml"],
    });
    expect(
      await axi.fails(["data", "prefs", PKG, "--file", "missing.xml"], "PREFS_NOT_FOUND"),
    ).toMatchObject({ files: ["other.xml", "settings.xml"] });
    expect(await axi.ok(["data", "prefs", PKG, "--file", "settings.xml"])).toEqual(result);
    expect((await axi.ok(["data", "prefs", PKG, "--file", "other.xml"])).file).toBe("other.xml");
    expect(await bytes("settings")).toBe(before);
    expect(await bytes("other")).toBe(second);
  });

  test("refuses absent and non-debuggable apps", async () => {
    expect(await axi.fails(["data", "prefs", `${PKG}.missing`], "APP_NOT_INSTALLED")).toMatchObject(
      { code: "APP_NOT_INSTALLED" },
    );
    await axi.ok(["app", "install", RELEASE_APK]);
    expect(await axi.fails(["data", "prefs", PKG], "APP_NOT_DEBUGGABLE")).toMatchObject({
      detail: `run-as: package not debuggable: ${PKG}`,
    });
  });
});
