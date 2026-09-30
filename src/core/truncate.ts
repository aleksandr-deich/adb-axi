import { join } from "node:path";
import { existsSync } from "node:fs";
import { adbAxiHome, writeFileAtomic } from "./state.js";

/** Default caps for `logs` and `shell` output. */
export const MAX_LINES = 50;
export const MAX_BYTES = 4096;
/** Default cap for a single long field, such as a crash message. */
export const MAX_FIELD_CHARS = 500;

export interface LineWindow {
  /** The lines that fit inside the caps. */
  lines: string[];
  /** Total number of lines before truncation. */
  total: number;
  truncated: boolean;
}

export interface LineCaps {
  maxLines?: number;
  maxBytes?: number;
  /** `head` keeps the first lines (shell output); `tail` keeps the last (log dumps). */
  keep?: "head" | "tail";
}

/**
 * Keep as many whole lines as fit inside both caps. A single line longer than the byte
 * cap is still shown once, cut to the cap, so the window is never empty for non-empty input.
 */
export function capLines(input: string | readonly string[], caps: LineCaps = {}): LineWindow {
  const maxLines = caps.maxLines ?? MAX_LINES;
  const maxBytes = caps.maxBytes ?? MAX_BYTES;
  const all = typeof input === "string" ? splitLines(input) : [...input];
  const ordered = caps.keep === "tail" ? [...all].reverse() : all;

  const kept: string[] = [];
  let bytes = 0;
  let cut = false;
  for (const line of ordered) {
    const size = Buffer.byteLength(line, "utf8") + 1;
    if (kept.length >= maxLines) break;
    if (bytes + size > maxBytes) {
      if (kept.length === 0) {
        kept.push(cutToBytes(line, maxBytes));
        cut = true;
      }
      break;
    }
    kept.push(line);
    bytes += size;
  }
  const lines = caps.keep === "tail" ? kept.reverse() : kept;
  return { lines, total: all.length, truncated: cut || lines.length < all.length };
}

/** `shown: 5 of 12 lines`. */
export function shownLine(window: LineWindow, unit = "lines"): string {
  return `${window.lines.length} of ${window.total} ${unit}`;
}

/** Split text into lines without inventing a trailing empty line. */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/**
 * Cut a long single field and say how long it was:
 * `first chars... (truncated, 412 chars total)`. Short values pass through unchanged.
 */
export function truncateField(value: string, maxChars = MAX_FIELD_CHARS): string {
  const chars = Array.from(graphemes.segment(value), (part) => part.segment);
  if (chars.length <= maxChars) return value;
  return `${chars.slice(0, maxChars).join("")}... (truncated, ${chars.length} chars total)`;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function cutToBytes(line: string, maxBytes: number): string {
  let out = "";
  let bytes = 0;
  for (const { segment: char } of graphemes.segment(line)) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > maxBytes) break;
    out += char;
    bytes += size;
  }
  return out;
}

/**
 * Write complete output for `--full` to `<ADB_AXI_HOME>/out/<stem>.txt` and return the
 * absolute path. An existing file is never overwritten: `-2`, `-3`, ... is appended.
 */
export function writeFullOutput(stem: string, content: string): string {
  const dir = join(adbAxiHome(), "out");
  const safeStem = stem.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "") || "output";
  let path = join(dir, `${safeStem}.txt`);
  for (let n = 2; existsSync(path); n++) {
    path = join(dir, `${safeStem}-${n}.txt`);
  }
  writeFileAtomic(path, content);
  return path;
}
