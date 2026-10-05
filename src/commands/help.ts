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
    help: [
      "Flags go after the command, for example `adb-axi app start <pkg> --device <serial|avd>`",
      runHint(["<command>", "--help"], "for its arguments, flags and examples"),
    ],
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
  const defaultCommand = group.defaultCommand?.shipped ? group.defaultCommand : undefined;
  const base = defaultCommand === undefined ? {} : commandHelp(defaultCommand);
  const commands = visibleSubcommands(group);
  const example = defaultCommand ?? commands[0];
  return {
    ...base,
    command: commandLine([group.name]),
    summary: group.summary,
    ...(defaultCommand === undefined
      ? {}
      : {
          usage: familyUsage(defaultCommand),
          flags: defaultCommand.flags.map(flagRow),
        }),
    subcommands: commands.map((command) => ({
      command: commandLine(command.path),
      usage: familyUsage(command),
      summary: command.summary,
    })),
    global_flags: [...GLOBAL_FLAGS, HELP_FLAG].map((flag) =>
      flagRow(flag.name === "--timeout" ? { ...flag, default: "per command" } : flag),
    ),
    help: [
      ...(example === undefined
        ? []
        : [
            `Flags go after the command, for example \`${usageLine(example).replace("[flags]", "--device <serial|avd>")}\``,
          ]),
      runHint([group.name, "<subcommand>", "--help"], "for flag details, defaults and examples"),
    ],
  };
}

/** Compact family usages share globals once, but expose each command's own flags. */
function familyUsage(spec: CommandSpec): string {
  const flags = spec.flags.map((flag) =>
    flag.required === true ? flagUsage(flag) : `[${flagUsage(flag)}]`,
  );
  return usageLine(spec).replace("[flags]", [...flags, "[global flags]"].join(" "));
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
