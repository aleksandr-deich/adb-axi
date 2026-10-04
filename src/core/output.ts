import { homedir } from "node:os";
import { encode } from "@toon-format/toon";
import { errorObject, exitCodeForError } from "./errors.js";

export const BIN = "adb-axi";

export type OutputMode = "toon" | "json";
export type Output = Record<string, unknown>;

/**
 * Text of several lines, such as a remote command's stdout. JSON prints it as one string;
 * TOON prints it as a list with one line per row instead of one escaped string.
 */
export class TextBlock {
  readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  toJSON(): string {
    return this.text;
  }
}

/**
 * Render one data object for stdout, without a trailing newline. TOON and JSON come from
 * the same object; `undefined` values are dropped first so both formats carry the same keys.
 * Two differences are deliberate: a top-level `TextBlock` of several lines is a list of
 * lines in TOON, and a JSON mutation result (one with an `ok` line) also carries `noop`.
 */
export function render(data: Output, mode: OutputMode): string {
  if (mode === "json") return JSON.stringify(withNoop(dropUndefined(data)), null, 2);
  const parts: string[] = [];
  let plain: Output = {};
  const flush = (): void => {
    const clean = dropUndefined(plain);
    if (Object.keys(clean).length > 0) parts.push(encode(clean));
    plain = {};
  };
  for (const [key, value] of Object.entries(data)) {
    const lines = value instanceof TextBlock ? value.text.split("\n") : [];
    if (lines.length > 1) {
      flush();
      parts.push(encodeLines(key, lines));
    } else {
      plain[key] = value;
    }
  }
  flush();
  return parts.length === 0 ? encode({}) : parts.join("\n");
}

/** A TOON list field, `key[N]:` then `  - <line>` per line, each quoted as TOON quotes a value. */
function encodeLines(key: string, lines: readonly string[]): string {
  const header = `${encode({ [key]: 0 }).slice(0, -": 0".length)}[${lines.length}]:`;
  const items = lines.map((line) => `  - ${encode([line]).replace(/^\[1\]: /, "")}`);
  return [header, ...items].join("\n");
}

/** A mutation's JSON says whether it was a no-op as a boolean, next to its `ok` line. */
function withNoop(data: Output): Output {
  if (typeof data.ok !== "string") return data;
  const { ok, ...rest } = data;
  return { ok, noop: ok.endsWith(NOOP_SUFFIX), ...rest };
}

export function renderError(
  error: unknown,
  mode: OutputMode,
  device?: string,
): { output: string; exitCode: number } {
  const shape = errorObject(error);
  const output = device === undefined ? shape : withDeviceSelection(shape, device);
  return { output: `${render(output, mode)}\n`, exitCode: exitCodeForError(error) };
}

function dropUndefined(value: Output): Output {
  return JSON.parse(JSON.stringify(value)) as Output;
}

/** The mutation lead line: `<verb> <target> -> <state>`, used as the `ok` field. */
export function okLine(verb: string, target: string, state: string): string {
  return `${verb} ${target} -> ${state}`;
}

const NOOP_SUFFIX = " (no-op)";

/** A resulting state for a mutation that found the state already true. */
export function noop(state: string): string {
  return `${state}${NOOP_SUFFIX}`;
}

/**
 * An `adb-axi` command line for help output. Arguments that a shell would split or
 * expand are single-quoted; `<placeholders>` are kept as written.
 */
export function commandLine(args: readonly string[]): string {
  return [BIN, shellWords(args)].filter((part) => part !== "").join(" ");
}

/** Arguments joined for display, quoted where a shell would split or expand them. */
export function shellWords(args: readonly string[]): string {
  return args.map(quoteArg).join(" ");
}

/** A help entry: `Run \`adb-axi ...\`` plus an optional reason. */
export function runHint(args: readonly string[], reason?: string): string {
  const line = `Run \`${commandLine(args)}\``;
  return reason === undefined ? line : `${line} ${reason}`;
}

const SAFE_ARG = /^[A-Za-z0-9_@%+=:,./-]+$/;
/** `<pkg>`, or `'<command>'` for a placeholder that stands for one quoted argument. */
const PLACEHOLDER = /^(<[^<>]+>|'<[^<>']+>')$/;

function quoteArg(arg: string): string {
  if (SAFE_ARG.test(arg) || PLACEHOLDER.test(arg)) {
    return arg;
  }
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

/** Commands that act on no device, so a suggestion to run one never gets `--device`. */
const NO_DEVICE_COMMANDS = new Set(["devices", "update"]);

/**
 * Add `--device <device>` to every `adb-axi` command line in the output's help that acts
 * on a device and names none, so a suggested next step runs on the device the user picked
 * instead of failing with `DEVICE_AMBIGUOUS` when several are online.
 */
export function withDeviceSelection(output: Output, device: string): Output {
  const help = output.help;
  if (!Array.isArray(help)) return output;
  return {
    ...output,
    help: help.map((line: unknown) =>
      typeof line === "string"
        ? line.replace(/`adb-axi((?: [^`]*)?)`/g, (whole, args: string) => {
            const words = splitShellWords(args.trim());
            return needsDevice(words) ? `\`${withDeviceWords(words, device)}\`` : whole;
          })
        : line,
    ),
  };
}

function needsDevice(words: readonly string[]): boolean {
  if (NO_DEVICE_COMMANDS.has(words[0] ?? "")) return false;
  const end = words.indexOf("--");
  const flags = end === -1 ? words : words.slice(0, end);
  return !flags.some(
    (word) =>
      word === "--device" || word === "-s" || word.startsWith("--device=") || word === "--help",
  );
}

/** The command line with `--device <device>` added before any `--`, which ends the flags. */
function withDeviceWords(words: readonly string[], device: string): string {
  const end = words.indexOf("--");
  const flags = end === -1 ? words : words.slice(0, end);
  const rest = end === -1 ? [] : words.slice(end);
  return [BIN, ...flags, "--device", quoteArg(device), ...rest].join(" ");
}

/**
 * Split a command line that `commandLine` printed back into its arguments, each still as
 * printed (quoted where it was quoted), so it can be printed again unchanged.
 */
function splitShellWords(text: string): string[] {
  const words: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i] ?? "";
    if (char === "'") quoted = !quoted;
    if (char === "\\" && !quoted) {
      current += char + (text[i + 1] ?? "");
      i++;
      continue;
    }
    if (char === " " && !quoted) {
      if (current !== "") words.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current !== "") words.push(current);
  return words;
}

/** The home view header, with the user's home directory collapsed to `~`. */
export function homeHeader(description: string, execPath = process.argv[1] ?? ""): Output {
  const home = homedir();
  const bin = execPath.startsWith(home) ? `~${execPath.slice(home.length)}` : execPath;
  return { bin, description };
}
