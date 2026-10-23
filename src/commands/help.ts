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
      "Requires Android SDK Platform-Tools 35.0.0 or newer for reliable shell disconnect exit codes; adb-axi never updates it",
      "Only a lone online emulator is auto-selected; physical devices require --device <serial> or ANDROID_SERIAL",
      "Flags go after the command, for example `adb-axi app start <pkg> --device <serial|avd>`",
      ...SERVER_HELP,
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
    flags: [
      ...spec.flags,
      ...GLOBAL_FLAGS.filter((flag) => !spec.hiddenGlobalFlags?.includes(flag.name)),
      HELP_FLAG,
    ].map((flag) =>
      flagRow(
        flag.name === "--timeout"
          ? { ...flag, default: formatDuration(spec.defaultTimeoutMs) }
          : flag,
      ),
    ),
    examples: [...spec.examples],
    ...(spec.path[0] === "doctor" && spec.path.length === 1
      ? { help: [...(spec.help ?? []), ...SERVER_HELP] }
      : spec.help === undefined
        ? {}
        : { help: [...spec.help] }),
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
      ...(defaultCommand?.help ?? []),
      ...(group.name === "doctor" ? SERVER_HELP : []),
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

const SERVER_HELP = [
  "Without --server, --server-start or saved selection, native adb behavior is unchanged: ADB_SERVER_SOCKET wins, else ANDROID_ADB_SERVER_ADDRESS and ANDROID_ADB_SERVER_PORT (local:5037 by default); adb may auto-start",
  "Selected mode accepts TCP destinations with an explicit port (tcp:<port>, tcp:<host>:<port>, tcp:[<ipv6>]:<port>); every nonempty native selector must agree, including ignored selectors",
  "--server overrides saved selection only for this invocation; a different endpoint defaults to never rather than inheriting auto permission. --server-start alone requires a saved or native selector",
  "Before each adb call, selected mode probes host:version directly and refuses unavailable, non-adb or incompatible endpoints; start=never makes no explicit start request; start=auto may explicitly start a missing local endpoint. adb-axi never runs kill-server",
  "This preflight is not airtight: if the server dies or changes after the check, native adb can still start or replace one on that same selected endpoint, never a fallback default endpoint",
  "Persist selection by writing version 1, endpoint and start to $ADB_AXI_HOME/server.json (otherwise ~/.adb-axi/server.json); this routes adb-axi only, not raw adb, Gradle or UI tools",
  'For example: mkdir -p "$ADB_AXI_HOME" && printf \'%s\\n\' \'{"version":1,"endpoint":"tcp:localhost:6137","start":"never"}\' > "$ADB_AXI_HOME/server.json" (set ADB_AXI_HOME to a task directory first); remove server.json to restore legacy mode',
];

const HELP_FLAG: FlagSpec = { name: "--help", type: "boolean", description: "Show this help" };

function flagRow(flag: FlagSpec): { flag: string; default: string; description: string } {
  const usage = flag.alias ? `${flagUsage(flag)}, ${flag.alias}` : flagUsage(flag);
  return {
    flag: flag.required === true ? `${usage} (required)` : usage,
    default: flag.default ?? "-",
    description: flag.description,
  };
}
