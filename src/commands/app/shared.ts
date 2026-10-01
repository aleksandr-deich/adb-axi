import type { ReadOptions } from "../../android/read.js";
import { AdbAxiError } from "../../core/errors.js";
import type { CommandContext } from "../types.js";

/** How an unknown or absent value prints, in rows and in fields. */
export const UNKNOWN = "-";

/** The device a command acts on. Commands with `device: "target"` always have one. */
export function targetSerial(context: CommandContext): string {
  if (context.target === undefined) {
    throw new AdbAxiError("INTERNAL_ERROR", "the command ran without a resolved device");
  }
  return context.target.serial;
}

/** What every device read of a command takes: its one deadline. */
export function readOptions(context: CommandContext): ReadOptions {
  return { deadline: context.deadline };
}

/** `1.4.0 (57)`, `- (57)` when only the code is known, `-` when neither is. */
export function formatVersion(name: string | null, code: number | null): string {
  if (name === null && code === null) return UNKNOWN;
  const label = name ?? UNKNOWN;
  return code === null ? label : `${label} (${code})`;
}
