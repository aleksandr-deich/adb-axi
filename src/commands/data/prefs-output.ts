import { render, type Output, type OutputMode } from "../../core/output.js";
import { truncateField, writeFullOutput } from "../../core/truncate.js";
import type { PreferenceRow } from "./prefs-xml.js";

export function presentPreferences(
  file: string,
  source: string,
  rows: PreferenceRow[],
  mode: OutputMode,
  pkg: string,
  full: boolean,
): Output {
  let cut = rows.length > 50;
  const shown = rows.slice(0, 50).map((row) => {
    const key = truncateField(row.key);
    let value = row.value;
    if (typeof value === "string") value = truncateField(value);
    else if (Array.isArray(value)) {
      const items: string[] = [];
      let size = 0;
      for (const item of value) {
        const short = truncateField(item, 100);
        if (items.length === 20 || size + short.length > 500) break;
        items.push(short);
        size += short.length;
      }
      if (items.length < value.length)
        items.push(`... (${value.length - items.length} more items)`);
      value = items;
    }
    if (key !== row.key || JSON.stringify(value) !== JSON.stringify(row.value)) cut = true;
    return { ...row, key, value };
  });
  const out: Output = {
    file,
    ...(source === file ? {} : { source }),
    count: `${rows.length} preferences`,
    rows: shown,
  };
  if (cut) {
    out.shown = `${shown.length} of ${rows.length} rows; long fields truncated`;
    if (full)
      out.full = writeFullOutput(`prefs-${pkg}`, `${render({ file, source, rows }, mode)}\n`);
    else out.help = ["Run the same command with `--full` to write complete rows to a private file"];
  }
  return out;
}
