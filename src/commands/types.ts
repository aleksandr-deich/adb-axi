import type { FlagSpec, FlagValue, PositionalSpec } from "../core/args.js";
import type { Output, OutputMode } from "../core/output.js";

/** Everything a command handler receives once its arguments are validated. */
export interface CommandContext {
  spec: CommandSpec;
  flags: Record<string, FlagValue>;
  positionals: Record<string, string | string[]>;
  mode: OutputMode;
  /** `--timeout` when given, otherwise the command's default. */
  timeoutMs: number;
  debug: boolean;
}

export type CommandRun = (context: CommandContext) => Promise<Output>;

/** Whether the command acts on one resolved device (7.2) or on the host / all devices. */
export type DeviceUse = "target" | "none";

export interface CommandSpec {
  kind: "command";
  /** Full path after `adb-axi`, for example `["app", "start"]`. */
  path: readonly string[];
  summary: string;
  positionals: readonly PositionalSpec[];
  /** Command-specific flags; the global flags are added automatically. */
  flags: readonly FlagSpec[];
  examples: readonly string[];
  defaultTimeoutMs: number;
  device: DeviceUse;
  /**
   * Shipped commands appear in help and suggestions. Unshipped ones are hidden stubs:
   * dispatchable (so the core can be tested end to end through them) but never advertised.
   */
  shipped: boolean;
  run: CommandRun;
}

/** A noun with subcommands, such as `app`. `defaultCommand` runs when no subcommand is named. */
export interface GroupSpec {
  kind: "group";
  name: string;
  summary: string;
  subcommands: readonly CommandSpec[];
  defaultCommand?: CommandSpec;
}

export type RegistryEntry = CommandSpec | GroupSpec;

export interface Registry {
  /** Top-level entries keyed by the first word after `adb-axi`. */
  entries: Readonly<Record<string, RegistryEntry>>;
  home: CommandSpec;
}
