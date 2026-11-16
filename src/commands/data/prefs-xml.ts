import { SaxesParser } from "saxes";
import { AdbAxiError } from "../../core/errors.js";

export const MAX_PREFS_BYTES = 4 * 1024 * 1024;

export interface PreferenceRow {
  key: string;
  type: "string" | "boolean" | "int" | "long" | "float" | "set";
  value: string | number | boolean | string[];
}

export function assertPrefsFile(name: string): void {
  if (
    name === "" ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    Array.from(name).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  ) {
    throw new AdbAxiError(
      "VALIDATION_ERROR",
      "--file must be a SharedPreferences file name, not a path",
    );
  }
}

export function parsePreferences(xml: string): PreferenceRow[] {
  const invalid = (): never => {
    // Parser diagnostics can contain private values, so never forward them.
    throw new AdbAxiError("INVALID_OUTPUT", "SharedPreferences XML is invalid or unsupported");
  };
  if (Buffer.byteLength(xml, "utf8") > MAX_PREFS_BYTES) {
    throw new AdbAxiError("INVALID_OUTPUT", "SharedPreferences XML exceeds the 4 MiB read limit");
  }
  const rows: PreferenceRow[] = [];
  const keys = new Set<string>();
  const stack: { tag: string; attrs: Record<string, string>; text: string; items: string[] }[] = [];
  const parser = new SaxesParser({ xmlns: false });
  // Android serializes C0 controls as numeric references even though XML 1.0 forbids them.
  // Named entities return those code points without XML 1.1's newline normalization.
  let prefix = "adbAxiControl";
  while (xml.includes(prefix)) prefix += "x";
  const input = xml.replace(
    /<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|&#(?:x[0-9a-fA-F]+|[0-9]+);/g,
    (reference) => {
      if (!reference.startsWith("&#")) return reference;
      const code = reference.startsWith("&#x")
        ? Number.parseInt(reference.slice(3, -1), 16)
        : Number(reference.slice(2, -1));
      if (code < 0 || code > 31 || [9, 10, 13].includes(code)) return reference;
      const entity = `${prefix}${code}`;
      parser.ENTITIES[entity] = String.fromCharCode(code);
      return `&${entity};`;
    },
  );
  parser.on("error", invalid);
  parser.on("doctype", invalid);
  parser.on("processinginstruction", invalid);
  parser.on("opentag", ({ name, attributes }) => {
    const parent = stack.at(-1);
    if (stack.length === 0) {
      if (name !== "map" || Object.keys(attributes).length !== 0) invalid();
    } else if (stack.length === 1) {
      if (!["string", "boolean", "int", "long", "float", "set"].includes(name)) invalid();
      if (!Object.hasOwn(attributes, "name")) invalid();
      const allowed = name === "string" || name === "set" ? ["name"] : ["name", "value"];
      if (Object.keys(attributes).some((key) => !allowed.includes(key))) invalid();
      if (allowed.includes("value") && !Object.hasOwn(attributes, "value")) invalid();
    } else if (
      stack.length !== 2 ||
      parent?.tag !== "set" ||
      name !== "string" ||
      Object.keys(attributes).length !== 0
    ) {
      invalid();
    }
    stack.push({ tag: name, attrs: attributes, text: "", items: [] });
  });
  const text = (value: string): void => {
    const node = stack.at(-1);
    if (node === undefined) {
      if (value.trim() !== "") invalid();
    } else if (node.tag === "string") node.text += value;
    else if (value.trim() !== "") invalid();
  };
  parser.on("text", text);
  parser.on("cdata", text);
  parser.on("closetag", () => {
    const node = stack.pop();
    if (node === undefined) return invalid();
    if (stack.length === 2) {
      stack.at(-1)?.items.push(node.text);
      return;
    }
    if (stack.length !== 1) return;
    const key = node.attrs.name ?? invalid();
    if (keys.has(key)) invalid();
    keys.add(key);
    const type = node.tag as PreferenceRow["type"];
    let value: PreferenceRow["value"];
    const raw = node.attrs.value ?? "";
    switch (type) {
      case "string":
        value = node.text;
        break;
      case "set":
        value = [...new Set(node.items)];
        break;
      case "boolean":
        if (raw !== "true" && raw !== "false") invalid();
        value = raw === "true";
        break;
      case "int":
      case "long": {
        if (raw.length > 21 || !/^[+-]?\d+$/.test(raw)) invalid();
        const integer = BigInt(raw);
        const bits = type === "int" ? 32n : 64n;
        if (integer < -(1n << (bits - 1n)) || integer >= 1n << (bits - 1n)) invalid();
        // All longs use decimal strings so JSON and TOON never round 64-bit values.
        value = type === "long" ? String(integer) : Number(integer);
        break;
      }
      case "float":
        if (["NaN", "Infinity", "-Infinity"].includes(raw)) value = raw;
        else {
          if (
            !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw) ||
            !Number.isFinite(Number(raw))
          )
            invalid();
          value = Object.is(Number(raw), -0) ? "-0.0" : Number(raw);
        }
        break;
    }
    rows.push({ key, type, value });
  });
  try {
    parser.write(input).close();
  } catch {
    invalid();
  }
  return rows;
}
