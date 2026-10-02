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
  /** Set when a single line longer than the byte cap was cut: its bytes shown and in full. */
  cut?: { shownBytes: number; totalBytes: number };
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
  let cut: LineWindow["cut"];
  for (const line of ordered) {
    const size = Buffer.byteLength(line, "utf8") + 1;
    if (kept.length >= maxLines) break;
    if (bytes + size > maxBytes) {
      if (kept.length === 0) {
        const shown = cutToBytes(line, maxBytes);
        kept.push(shown);
        if (shown !== line) {
          cut = {
            shownBytes: Buffer.byteLength(shown, "utf8"),
            totalBytes: Buffer.byteLength(line, "utf8"),
          };
        }
      }
      break;
    }
    kept.push(line);
    bytes += size;
  }
  const lines = caps.keep === "tail" ? kept.reverse() : kept;
  const window: LineWindow = {
    lines,
    total: all.length,
    truncated: cut !== undefined || lines.length < all.length,
  };
  return cut === undefined ? window : { ...window, cut };
}

/** `shown: 5 of 12 lines`, or `1 of 1 lines, cut at 4096 of 20480 bytes` for a cut line. */
export function shownLine(window: LineWindow, unit = "lines"): string {
  const shown = `${window.lines.length} of ${window.total} ${unit}`;
  if (window.cut === undefined) return shown;
  return `${shown}, cut at ${window.cut.shownBytes} of ${window.cut.totalBytes} bytes`;
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
export function writeFullOutput(
  stem: string,
  content: string,
  write: (path: string, content: string) => void = writeFileAtomic,
): string {
  const dir = join(adbAxiHome(), "out");
  const safeStem = stem.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "") || "output";
  let path = join(dir, `${safeStem}.txt`);
  for (let n = 2; existsSync(path); n++) {
    path = join(dir, `${safeStem}-${n}.txt`);
  }
  write(path, content);
  return path;
}
