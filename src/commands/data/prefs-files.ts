import { AdbAxiError } from "../../core/errors.js";
import { shellWords } from "../../core/output.js";
import { assertPrefsFile, MAX_PREFS_BYTES } from "./prefs-xml.js";

export const PREFS_LIST_SCRIPT =
  "if [ -L shared_prefs ]; then echo 'shared_prefs is a symbolic link' >&2; exit 1; fi; if [ ! -e shared_prefs ]; then exit 0; fi; if [ ! -d shared_prefs ]; then echo 'shared_prefs is not a directory' >&2; exit 1; fi; find shared_prefs -maxdepth 1 -type f \\( -name '*.xml' -o -name '*.xml.bak' \\) -print0";

export function prefsInventory(bytes: Uint8Array): string[] {
  return [
    ...new Set(
      decodePrefsUtf8(bytes)
        .split("\0")
        .filter(Boolean)
        .map((path) => {
          if (!path.startsWith("shared_prefs/"))
            throw new AdbAxiError("INVALID_OUTPUT", "Unexpected SharedPreferences file listing");
          const name = path.slice("shared_prefs/".length).replace(/\.xml\.bak$/, ".xml");
          try {
            assertPrefsFile(name);
          } catch {
            throw new AdbAxiError(
              "INVALID_OUTPUT",
              "SharedPreferences directory contains an unsupported file name",
            );
          }
          if (!name.endsWith(".xml"))
            throw new AdbAxiError("INVALID_OUTPUT", "Unexpected SharedPreferences file listing");
          return name;
        }),
    ),
  ].sort();
}

export function prefsReadScript(name: string): string {
  assertPrefsFile(name);
  // Android restores the backup on load, even when a partly written primary exists.
  return `file=${shellWords([`shared_prefs/${name}`])}; if [ -e "$file.bak" ] || [ -L "$file.bak" ]; then file="$file.bak"; fi; if [ -L shared_prefs ] || [ -L "$file" ] || [ ! -f "$file" ]; then echo 'SharedPreferences source is missing or not a regular file; the app may be writing it; run again' >&2; exit 1; fi; printf '%s\\0' "$file"; head -c ${MAX_PREFS_BYTES + 1} "$file"`;
}

export function decodePrefsUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new AdbAxiError("INVALID_OUTPUT", "SharedPreferences output is not valid UTF-8");
  }
}

export function prefsSnapshot(bytes: Buffer, name: string): { source: string; xml: string } {
  const end = bytes.indexOf(0);
  if (end < 0)
    throw new AdbAxiError("INVALID_OUTPUT", "SharedPreferences read did not identify its source");
  const source = decodePrefsUtf8(bytes.subarray(0, end));
  if (![`shared_prefs/${name}`, `shared_prefs/${name}.bak`].includes(source))
    throw new AdbAxiError("INVALID_OUTPUT", "Unexpected SharedPreferences source");
  return {
    source: source.slice("shared_prefs/".length),
    xml: decodePrefsUtf8(bytes.subarray(end + 1)),
  };
}
