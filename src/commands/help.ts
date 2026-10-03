import { flagUsage, formatDuration, GLOBAL_FLAGS, usageLine, type FlagSpec } from "../core/args.js";
import { BIN, commandLine, runHint, type Output } from "../core/output.js";
import { entryCommands, isVisible, visibleSubcommands } from "./registry.js";
import type { CommandSpec, GroupSpec, Registry } from "./types.js";

/** `adb-axi --help`: the shipped commands and the global flags. Hidden stubs never appear. */
export function topLevelHelp(registry: Registry): Output {
  const commands = Object.values(registry.entries)
    .filter(isVisible)
    .flatMap(entryCommands)
    .filter((command) => command.shipped)
    .map((command) => ({ command: commandLine(command.path), summary: command.summary }));
  if (registry.home.shipped) {
    commands.unshift({ command: BIN, summary: registry.home.summary });
  }
  return {
    usage: `${BIN} <command> [subcommand] [args] [flags]`,
    commands,
    global_flags: [...GLOBAL_FLAGS, HELP_FLAG].map((flag) =>
      flagRow(flag.name === "--timeout" ? { ...flag, default: "per command" } : flag),
    ),
    help: [runHint(["<command>", "--help"], "for its arguments, flags and examples")],
  };
}

/** `adb-axi <command> --help` for one shipped command. */
export function commandHelp(spec: CommandSpec): Output {
  return {
    command: commandLine(spec.path),
    summary: spec.summary,
    usage: usageLine(spec),
    ...(spec.positionals.length > 0
      ? {
          args: spec.positionals.map((p) => ({
            name: `<${p.name}>`,
            required: p.required,
            description: p.description,
          })),
        }
      : {}),
    flags: [...spec.flags, ...GLOBAL_FLAGS, HELP_FLAG].map((flag) =>
      flagRow(
        flag.name === "--timeout"
          ? { ...flag, default: formatDuration(spec.defaultTimeoutMs) }
          : flag,
      ),
    ),
    examples: [...spec.examples],
  };
}

/** `adb-axi <group> --help`, or a bare group without a default command. */
export function groupHelp(group: GroupSpec): Output {
  const base = group.defaultCommand?.shipped ? commandHelp(group.defaultCommand) : {};
  return {
    ...base,
    command: commandLine([group.name]),
    summary: group.summary,
    subcommands: visibleSubcommands(group).map((command) => ({
      command: commandLine(command.path),
      summary: command.summary,
    })),
    help: [
      runHint([group.name, "<subcommand>", "--help"], "for its arguments, flags and examples"),
    ],
  };
}

const HELP_FLAG: FlagSpec = { name: "--help", type: "boolean", description: "Show this help" };

function flagRow(flag: FlagSpec): { flag: string; default: string; description: string } {
  const usage = flag.alias ? `${flagUsage(flag)}, ${flag.alias}` : flagUsage(flag);
  return {
    flag: flag.required === true ? `${usage} (required)` : usage,
    default: flag.default ?? "-",
    description: flag.description,
  };
}
