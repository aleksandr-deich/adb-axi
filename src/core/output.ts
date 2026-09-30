import { homedir } from "node:os";
import { encode } from "@toon-format/toon";
import { errorObject, exitCodeForError } from "./errors.js";

export const BIN = "adb-axi";

export type OutputMode = "toon" | "json";
export type Output = Record<string, unknown>;

/**
 * Render one data object for stdout, without a trailing newline. TOON and JSON come from
 * the same object; `undefined` values are dropped first so both formats carry the same keys.
 */
export function render(data: Output, mode: OutputMode): string {
  const clean = dropUndefined(data);
  return mode === "json" ? JSON.stringify(clean, null, 2) : encode(clean);
}

export function renderError(
  error: unknown,
  mode: OutputMode,
): { output: string; exitCode: number } {
  return { output: `${render(errorObject(error), mode)}\n`, exitCode: exitCodeForError(error) };
}

function dropUndefined(value: Output): Output {
  return JSON.parse(JSON.stringify(value)) as Output;
}

/** The mutation lead line: `<verb> <target> -> <state>`, used as the `ok` field. */
export function okLine(verb: string, target: string, state: string): string {
  return `${verb} ${target} -> ${state}`;
}

/** A resulting state for a mutation that found the state already true. */
export function noop(state: string): string {
  return `${state} (no-op)`;
}

/**
 * An `adb-axi` command line for help output. Arguments that a shell would split or
 * expand are single-quoted; `<placeholders>` are kept as written.
 */
export function commandLine(args: readonly string[]): string {
  return [BIN, ...args.map(quoteArg)].join(" ");
}

/** A help entry: `Run \`adb-axi ...\`` plus an optional reason. */
export function runHint(args: readonly string[], reason?: string): string {
  const line = `Run \`${commandLine(args)}\``;
  return reason === undefined ? line : `${line} ${reason}`;
}

const SAFE_ARG = /^[A-Za-z0-9_@%+=:,./-]+$/;
const PLACEHOLDER = /^<[^<>]+>$/;

function quoteArg(arg: string): string {
  if (SAFE_ARG.test(arg) || PLACEHOLDER.test(arg)) {
    return arg;
  }
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

/** The home view header, with the user's home directory collapsed to `~`. */
export function homeHeader(description: string, execPath = process.argv[1] ?? ""): Output {
  const home = homedir();
  const bin = execPath.startsWith(home) ? `~${execPath.slice(home.length)}` : execPath;
  return { bin, description };
}
