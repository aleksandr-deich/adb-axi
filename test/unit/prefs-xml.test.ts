import { describe, expect, test } from "vitest";
import {
  assertPrefsFile,
  MAX_PREFS_BYTES,
  parsePreferences,
} from "../../src/commands/data/prefs-xml.js";

describe("untrusted SharedPreferences XML", () => {
  test("preserves XML escapes, Unicode, empty values and exact signed longs", () => {
    expect(
      parsePreferences(`<?xml version='1.0' encoding='utf-8' standalone='yes' ?>
<map><string name="&quot;">&#x1f680;&amp;&lt;<![CDATA[>]]></string>
<string name="empty"></string><set name="set"><string>a&amp;b</string><string></string></set>
<set name="emptyset"/><long name="max" value="9223372036854775807"/>
<long name="min" value="-9223372036854775808"/><boolean name="b" value="false"/>
<int name="i" value="-2147483648"/><float name="f" value="1.25"/></map>`),
    ).toEqual([
      { key: '"', type: "string", value: "🚀&<>" },
      { key: "empty", type: "string", value: "" },
      { key: "set", type: "set", value: ["a&b", ""] },
      { key: "emptyset", type: "set", value: [] },
      { key: "max", type: "long", value: "9223372036854775807" },
      { key: "min", type: "long", value: "-9223372036854775808" },
      { key: "b", type: "boolean", value: false },
      { key: "i", type: "int", value: -2147483648 },
      { key: "f", type: "float", value: 1.25 },
    ]);
  });

  test.each([
    '<!DOCTYPE map SYSTEM "file:///etc/passwd"><map/>',
    '<!DOCTYPE map SYSTEM "https://example.invalid/secret"><map/>',
    '<!DOCTYPE map [<!ENTITY a "&a;&a;">]><map><string name="x">&a;</string></map>',
    '<map><string name="x">&custom;</string></map>',
    '<map><string name="x"></map>',
    '<map><int name="x" value="2147483648"/></map>',
    '<map><long name="x" value="9223372036854775808"/></map>',
    '<map><float name="x" value="1e999"/></map>',
    '<map><boolean name="x" value="yes"/></map>',
    '<map><int name="x"/></map>',
    '<map><string name="x"/><string name="x"/></map>',
    '<map><set name="x"><set/></set></map>',
    '<map><string name="x"><string/></string></map>',
  ])("rejects unsafe or invalid XML %#", (xml) => {
    expect(() => parsePreferences(xml)).toThrow(
      expect.objectContaining({ code: "INVALID_OUTPUT" }),
    );
  });

  test("bounds XML bytes before parsing", () => {
    expect(() =>
      parsePreferences(`<map><string name="x">${"x".repeat(MAX_PREFS_BYTES)}</string></map>`),
    ).toThrow(expect.objectContaining({ code: "INVALID_OUTPUT" }));
  });

  test.each([
    "",
    ".",
    "..",
    "../secret.xml",
    "/secret.xml",
    "a/b.xml",
    "a\\b.xml",
    "a\0.xml",
    "a\n.xml",
  ])("rejects path-like selectors %#", (name) => {
    expect(() => {
      assertPrefsFile(name);
    }).toThrow(expect.objectContaining({ code: "VALIDATION_ERROR" }));
  });
});
