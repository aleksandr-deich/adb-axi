import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { adbAxiHome, isErrno } from "./state.js";

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
 * absolute path (see `FullOutputFile`).
 */
export function writeFullOutput(stem: string, content: string): string {
  const file = new FullOutputFile(stem);
  try {
    file.write(content);
    return file.keep();
  } finally {
    file.discard();
  }
}

/**
 * Complete output for `--full`, written as it arrives to a private temporary file and kept
 * as `<ADB_AXI_HOME>/out/<stem>.txt`; a name that is taken gets a `-2`, `-3`, ... suffix.
 * `keep` links the finished file to its final name, which fails rather than replaces when
 * the name is taken: concurrent runs never share a path, and no path ever holds partial
 * output.
 */
export class FullOutputFile {
  private readonly stem: string;
  private tmp: string | undefined;
  private fd: number | undefined;
  /** The first write failure; `keep` throws it. */
  private failure: Error | undefined;

  constructor(stem: string) {
    this.stem = stem.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "") || "output";
  }

  /** Append to the file. Never throws: a failure stops the writing and `keep` throws it. */
  write(chunk: string | Uint8Array): void {
    if (this.failure !== undefined) return;
    try {
      const fd = this.open();
      const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      for (let offset = 0; offset < bytes.length;) {
        offset += writeSync(fd, bytes, offset);
      }
    } catch (error) {
      this.failure = error instanceof Error ? error : new Error(String(error));
    }
  }

  /** Flush the file to disk and give it its final name, which is returned. */
  keep(): string {
    if (this.failure !== undefined) throw this.failure;
    const fd = this.open();
    fsyncSync(fd);
    this.close();
    const tmp = this.tmp ?? "";
    try {
      for (let n = 1; ; n++) {
        const path = join(dirname(tmp), `${this.stem}${n === 1 ? "" : `-${n}`}.txt`);
        try {
          linkSync(tmp, path);
          return path;
        } catch (error) {
          if (!isErrno(error, "EEXIST")) throw error;
        }
      }
    } finally {
      this.discard();
    }
  }

  /** Remove the temporary file; a kept file stays under its final name. */
  discard(): void {
    this.close();
    if (this.tmp !== undefined) rmSync(this.tmp, { force: true });
    this.tmp = undefined;
  }

  private open(): number {
    if (this.fd !== undefined) return this.fd;
    const dir = join(adbAxiHome(), "out");
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.full-${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
    this.fd = openSync(tmp, "wx");
    this.tmp = tmp;
    return this.fd;
  }

  private close(): void {
    if (this.fd === undefined) return;
    closeSync(this.fd);
    this.fd = undefined;
  }
}
