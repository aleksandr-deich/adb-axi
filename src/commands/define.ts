import { AdbAxiError } from "../core/errors.js";
import { commandLine, runHint } from "../core/output.js";
import type { CommandRun, CommandSpec, GroupSpec } from "./types.js";

/** Deadline for reads and ordinary actions when a command sets no other default (7.4). */
export const DEFAULT_TIMEOUT_MS = 15_000;

type CommandInput = Pick<CommandSpec, "path" | "summary" | "examples"> &
  Partial<Omit<CommandSpec, "kind" | "path" | "summary" | "examples">>;

/**
 * Build a command spec. Commands start as hidden stubs (`shipped: false`, `run`
 * throwing `NOT_IMPLEMENTED`); the slice that implements one sets both.
 */
export function defineCommand(input: CommandInput): CommandSpec {
  return {
    kind: "command",
    positionals: [],
    flags: [],
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
    device: "target",
    shipped: false,
    run: notImplemented,
    ...input,
  };
}

export function defineGroup(input: Omit<GroupSpec, "kind">): GroupSpec {
  return { kind: "group", ...input };
}

/** The error for a registered command (or group) that is not built yet. */
export function notAvailable(path: readonly string[]): AdbAxiError {
  return new AdbAxiError(
    "NOT_IMPLEMENTED",
    `\`${commandLine(path)}\` is not available in this build`,
    { help: [runHint(["--help"], "to see the commands this build ships")] },
  );
}

/** Handler for a registered command that is not built yet. It never touches a device. */
export const notImplemented: CommandRun = (context) =>
  Promise.reject(notAvailable(context.spec.path));
