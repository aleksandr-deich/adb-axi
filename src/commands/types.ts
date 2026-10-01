import type { AdbClient } from "../adb/run.js";
import type { FlagSpec, FlagValue, PositionalSpec } from "../core/args.js";
import type { Deadline } from "../core/deadline.js";
import type { Output, OutputMode } from "../core/output.js";
import type { Target } from "../device/resolve.js";

/** Everything a command handler receives once its arguments are validated. */
export interface CommandContext {
  spec: CommandSpec;
  flags: Record<string, FlagValue>;
  positionals: Record<string, string | string[]>;
  mode: OutputMode;
  /** `--timeout` when given, otherwise the command's default. */
  timeoutMs: number;
  debug: boolean;
  /** The command's single deadline; every device call takes what is left of it. */
  deadline: Deadline;
  /** The adb client, located on first use (`ADB_NOT_FOUND` when there is none). */
  adb: () => AdbClient;
  /** The resolved device for commands with `device: "target"`, checked online. */
  target: Target | undefined;
  env: NodeJS.ProcessEnv;
  /** Whether `adb-axi <path>` ships in this build, so help lines never name one that does not. */
  isShipped: (path: readonly string[]) => boolean;
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
