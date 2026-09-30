import { runAxiCli, type AxiCliCommand } from "axi-sdk-js";
import { editDistance, parseArgs } from "./core/args.js";
import { AdbAxiError } from "./core/errors.js";
import {
  commandLine,
  homeHeader,
  render,
  renderError,
  runHint,
  type Output,
  type OutputMode,
} from "./core/output.js";
import { notAvailable } from "./commands/define.js";
import { commandHelp, groupHelp, topLevelHelp } from "./commands/help.js";
import { isVisible, REGISTRY, shippedEntryNames, visibleSubcommands } from "./commands/registry.js";
import type { CommandContext, CommandSpec, GroupSpec, Registry } from "./commands/types.js";
import { VERSION } from "./version.js";

export const DESCRIPTION =
  "Truthful, token-efficient adb for agents: devices, app lifecycle, logs and app data";

export interface MainOptions {
  argv?: readonly string[];
  registry?: Registry;
  stdout?: { write: (chunk: string) => unknown };
}

/** What `resolveContext` hands a handler: output to print as is, or a validated command to run. */
type Invocation = { kind: "output"; output: Output } | { kind: "run"; context: CommandContext };

/** Global flags that take a value, for reading flags placed before the command. */
const VALUE_FLAGS = new Set(["-s", "--device", "--timeout"]);

export async function main(options: MainOptions = {}): Promise<void> {
  const registry = options.registry ?? REGISTRY;
  const stdout = options.stdout ?? process.stdout;
  const { mode, argv } = extractJsonFlag(options.argv ?? process.argv.slice(2));

  // G1: a flag before the command is rejected with the corrected command line, before
  // anything touches adb. Bare --help and version flags stay with the SDK.
  const first = argv[0];
  if (first?.startsWith("-") === true && !(argv.length === 1 && isSdkBareFlag(first))) {
    writeError(stdout, leadingFlagError(argv, registry), mode);
    return;
  }

  // G2: the SDK always renders TOON, so JSON home and JSON top-level help render here.
  if (mode === "json" && argv.length === 0) {
    await runDirect(stdout, mode, async () => {
      const invocation = resolveInvocation(registry, undefined, [], mode);
      const output = await produce(invocation);
      return { ...homeHeader(DESCRIPTION), ...output };
    });
    return;
  }
  if (mode === "json" && argv.length === 1 && argv[0] === "--help") {
    stdout.write(`${render(topLevelHelp(registry), mode)}\n`);
    return;
  }

  const commands: Record<string, AxiCliCommand<Invocation>> = {};
  for (const name of Object.keys(registry.entries)) {
    commands[name] = async (_args, invocation) => render(await produce(invocation), mode);
  }

  await runAxiCli<Invocation>({
    description: DESCRIPTION,
    version: VERSION,
    argv: [...argv],
    stdout,
    topLevelHelp: `${render(topLevelHelp(registry), mode)}\n`,
    commands,
    // The SDK merges `bin` and `description` into the home object itself.
    home: async (_args, invocation) => produce(invocation),
    // G4: help is resolved per subcommand inside `resolveContext`, never by the SDK.
    getCommandHelp: () => null,
    resolveContext: ({ command, args }) => resolveInvocation(registry, command, args, mode),
    renderUnknownCommand: (command) => render(unknownCommandError(command, registry), mode) + "\n",
    // G3: structured fields, the `error, code, <fields>, help` order, and exit codes.
    formatError: (error) => renderError(error, mode),
  });
}

async function produce(invocation: Invocation | undefined): Promise<Output> {
  if (invocation === undefined) {
    throw new Error("Command dispatched without a resolved invocation");
  }
  if (invocation.kind === "output") return invocation.output;
  return invocation.context.spec.run(invocation.context);
}

async function runDirect(
  stdout: { write: (chunk: string) => unknown },
  mode: OutputMode,
  produceOutput: () => Promise<Output>,
): Promise<void> {
  try {
    stdout.write(`${render(await produceOutput(), mode)}\n`);
  } catch (error) {
    writeError(stdout, error, mode);
  }
}

function writeError(
  stdout: { write: (chunk: string) => unknown },
  error: unknown,
  mode: OutputMode,
): void {
  const formatted = renderError(error, mode);
  stdout.write(formatted.output);
  process.exitCode = formatted.exitCode;
}

/**
 * `--json` is the one flag allowed anywhere, including before the command and alone (the
 * home view as JSON). Tokens after `--` belong to the command and are left alone.
 */
export function extractJsonFlag(argv: readonly string[]): { mode: OutputMode; argv: string[] } {
  const end = argv.indexOf("--");
  const head = end === -1 ? argv : argv.slice(0, end);
  const tail = end === -1 ? [] : argv.slice(end);
  const kept = head.filter((token) => token !== "--json");
  return { mode: kept.length === head.length ? "toon" : "json", argv: [...kept, ...tail] };
}

function isSdkBareFlag(flag: string): boolean {
  return flag === "--help" || flag === "-v" || flag === "-V" || flag === "--version";
}

/**
 * Build the error for flags placed before the command, with the corrected command line:
 * `adb-axi -s emulator-5554 logs` -> `adb-axi logs --device emulator-5554`.
 */
export function leadingFlagError(argv: readonly string[], registry: Registry): AdbAxiError {
  const leading: string[] = [];
  let i = 0;
  while (i < argv.length) {
    const token = argv[i] ?? "";
    if (!token.startsWith("-") || token === "--") break;
    const value = argv[i + 1];
    if (VALUE_FLAGS.has(token) && value !== undefined) {
      leading.push(token === "-s" ? "--device" : token, value);
      i += 2;
    } else {
      leading.push(token);
      i += 1;
    }
  }
  const shown = argv.slice(0, i).join(" ");
  const rest = argv.slice(i);
  const message = `\`${shown}\` must come after the command`;
  if (rest.length === 0) {
    return new AdbAxiError("VALIDATION_ERROR", message, {
      help: [runHint(["<command>", ...leading])],
    });
  }

  const words = commandWords(rest, registry);
  const after = rest.slice(words);
  const dashDash = after.indexOf("--");
  const corrected =
    dashDash === -1
      ? [...rest.slice(0, words), ...after, ...leading]
      : [
          ...rest.slice(0, words),
          ...after.slice(0, dashDash),
          ...leading,
          ...after.slice(dashDash),
        ];
  return new AdbAxiError("VALIDATION_ERROR", message, { help: [runHint(corrected)] });
}

/** How many leading tokens name the command: 2 for `app start`, 1 for `logs` or `shell`. */
function commandWords(tokens: readonly string[], registry: Registry): number {
  const entry = registry.entries[tokens[0] ?? ""];
  if (entry?.kind === "group" && entry.subcommands.some((sub) => sub.path[1] === tokens[1])) {
    return 2;
  }
  return 1;
}

function unknownCommandError(command: string, registry: Registry): Output {
  const shipped = shippedEntryNames(registry);
  const guess = closest(command, shipped);
  const help = [
    ...(guess === undefined ? [] : [runHint([guess], `if you meant \`${guess}\``)]),
    runHint(["--help"], "for every command and its summary"),
  ];
  return {
    error: `unknown command \`${command}\``,
    code: "VALIDATION_ERROR",
    commands: shipped,
    help,
  };
}

function closest(word: string, candidates: readonly string[]): string | undefined {
  let best: { word: string; distance: number } | undefined;
  for (const candidate of candidates) {
    const distance = editDistance(word, candidate);
    if (distance <= 2 && (best === undefined || distance < best.distance)) {
      best = { word: candidate, distance };
    }
  }
  return best?.word;
}

/**
 * Walk from the top-level command to one leaf, validate its arguments, and decide
 * whether this is a help request. Device resolution will slot in here, after parsing.
 */
function resolveInvocation(
  registry: Registry,
  command: string | undefined,
  args: readonly string[],
  mode: OutputMode,
): Invocation {
  if (command === undefined) {
    return leafInvocation(registry.home, [], mode);
  }
  const entry = registry.entries[command];
  if (entry === undefined) {
    throw new Error(`No registry entry for dispatched command ${command}`);
  }
  if (entry.kind === "command") {
    return leafInvocation(entry, args, mode);
  }
  return groupInvocation(entry, args, mode);
}

function groupInvocation(group: GroupSpec, args: readonly string[], mode: OutputMode): Invocation {
  const first = args[0];
  const sub = group.subcommands.find((command) => command.path[1] === first);
  if (sub) {
    return leafInvocation(sub, args.slice(1), mode);
  }
  const helpForGroup = (): Output => {
    if (!isVisible(group)) throw notAvailable([group.name]);
    return groupHelp(group);
  };

  const flagOrNothing = first === undefined || first.startsWith("-");
  const defaultCommand = group.defaultCommand;
  if (defaultCommand && (flagOrNothing || defaultCommand.positionals.length > 0)) {
    return leafInvocation(defaultCommand, args, mode, helpForGroup);
  }
  if (first === undefined || args.includes("--help")) {
    return { kind: "output", output: helpForGroup() };
  }
  if (!isVisible(group)) throw notAvailable([group.name]);
  if (!first.startsWith("-")) throw unknownSubcommand(group, first);

  // Flags before the subcommand: say where the subcommand goes.
  const word = args.find((token) => group.subcommands.some((s) => s.path[1] === token));
  const corrected =
    word === undefined
      ? [group.name, "<subcommand>", ...args]
      : [group.name, word, ...args.filter((token) => token !== word)];
  throw new AdbAxiError(
    "VALIDATION_ERROR",
    `\`${commandLine([group.name])}\` needs a subcommand before its flags`,
    {
      fields: { subcommands: subcommandNames(group) },
      help: [runHint(corrected)],
    },
  );
}

function leafInvocation(
  spec: CommandSpec,
  args: readonly string[],
  mode: OutputMode,
  help: () => Output = () => commandHelp(spec),
): Invocation {
  const parsed = parseArgs(args, {
    path: spec.path,
    flags: spec.flags,
    positionals: spec.positionals,
    helpAvailable: spec.shipped,
  });
  if (parsed.help) {
    if (!spec.shipped) throw notAvailable(spec.path);
    return { kind: "output", output: help() };
  }
  const timeout = parsed.flags.timeout;
  return {
    kind: "run",
    context: {
      spec,
      flags: parsed.flags,
      positionals: parsed.positionals,
      mode,
      timeoutMs: typeof timeout === "number" ? timeout : spec.defaultTimeoutMs,
      debug: parsed.flags.debug === true,
    },
  };
}

function subcommandNames(group: GroupSpec): string[] {
  return visibleSubcommands(group).map((command) => command.path[1] ?? "");
}

function unknownSubcommand(group: GroupSpec, word: string): AdbAxiError {
  const names = subcommandNames(group);
  const guess = closest(word, names);
  return new AdbAxiError(
    "VALIDATION_ERROR",
    `unknown subcommand \`${word}\` for \`${commandLine([group.name])}\``,
    {
      fields: { subcommands: names },
      help: [
        ...(guess === undefined ? [] : [runHint([group.name, guess], `if you meant \`${guess}\``)]),
        runHint([group.name, "--help"], "for its subcommands"),
      ],
    },
  );
}
