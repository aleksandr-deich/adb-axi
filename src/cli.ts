import { runAxiCli, type AxiCliCommand } from "axi-sdk-js";
import { locateAdb } from "./adb/locate.js";
import { AdbClient } from "./adb/run.js";
import { editDistance, parseArgs } from "./core/args.js";
import { Deadline } from "./core/deadline.js";
import { AdbAxiError } from "./core/errors.js";
import {
  commandLine,
  homeHeader,
  render,
  renderError,
  runHint,
  withDeviceSelection,
  type Output,
  type OutputMode,
} from "./core/output.js";
import { notAvailable } from "./commands/define.js";
import { commandHelp, groupHelp, topLevelHelp } from "./commands/help.js";
import {
  isShippedPath,
  isVisible,
  REGISTRY,
  shippedEntryNames,
  visibleSubcommands,
} from "./commands/registry.js";
import type { CommandContext, CommandSpec, GroupSpec, Registry } from "./commands/types.js";
import { resolveTarget } from "./device/resolve.js";
import { readHostProcesses, type HostProcessList } from "./host/processes.js";
import { VERSION } from "./version.js";

export const DESCRIPTION =
  "Truthful, token-efficient adb for agents: devices, app lifecycle, logs and app data";

export interface MainOptions {
  argv?: readonly string[];
  registry?: Registry;
  stdout?: { write: (chunk: string) => unknown };
  env?: NodeJS.ProcessEnv;
  /** The host process list; tests pass a fixed one. */
  hostProcesses?: HostProcessList;
}

/** Per-run inputs every resolution step needs. */
interface Run {
  registry: Registry;
  mode: OutputMode;
  env: NodeJS.ProcessEnv;
  hostProcesses: HostProcessList;
}

/** What `resolveContext` hands a handler: output to print as is, or a validated command to run. */
type Invocation = { kind: "output"; output: Output } | { kind: "run"; context: CommandContext };

/** Global flags that take a value, for reading flags placed before the command. */
const VALUE_FLAGS = new Set(["-s", "--device", "--timeout"]);

export async function main(options: MainOptions = {}): Promise<void> {
  const registry = options.registry ?? REGISTRY;
  const stdout = options.stdout ?? process.stdout;
  const { mode, argv } = extractJsonFlag(options.argv ?? process.argv.slice(2));
  const run: Run = {
    registry,
    mode,
    env: options.env ?? process.env,
    hostProcesses: options.hostProcesses ?? readHostProcesses,
  };
  // Every suggested next step carries the device the user picked (7.2).
  const device = selectedDevice(argv);
  const selected = (output: Output): Output =>
    device === undefined ? output : withDeviceSelection(output, device);

  // The home view takes the global flags alone (`adb-axi --device emulator-5556`), and the
  // SDK always renders TOON, so JSON home and JSON top-level help render here too.
  if (argv.length === 0 ? mode === "json" : isHomeFlags(argv)) {
    await runDirect(stdout, mode, device, async () => {
      const invocation = await resolveInvocation(run, undefined, argv);
      const output = selected(await produce(invocation));
      return invocation.kind === "run" ? { ...homeHeader(DESCRIPTION), ...output } : output;
    });
    return;
  }

  // G1: a flag before the command is rejected with the corrected command line, before
  // anything touches adb. Bare --help and version flags stay with the SDK.
  const first = argv[0];
  if (first?.startsWith("-") === true && !(argv.length === 1 && isSdkBareFlag(first))) {
    writeError(stdout, leadingFlagError(argv, registry), mode, device);
    return;
  }

  if (mode === "json" && argv.length === 1 && argv[0] === "--help") {
    stdout.write(`${render(topLevelHelp(registry), mode)}\n`);
    return;
  }

  const commands: Record<string, AxiCliCommand<Invocation>> = {};
  for (const name of Object.keys(registry.entries)) {
    commands[name] = async (_args, invocation) => render(selected(await produce(invocation)), mode);
  }

  await runAxiCli<Invocation>({
    description: DESCRIPTION,
    version: VERSION,
    argv: [...argv],
    stdout,
    topLevelHelp: `${render(topLevelHelp(registry), mode)}\n`,
    commands,
    // The SDK merges `bin` and `description` into the home object itself.
    home: async (_args, invocation) => selected(await produce(invocation)),
    // G4: help is resolved per subcommand inside `resolveContext`, never by the SDK.
    getCommandHelp: () => null,
    resolveContext: ({ command, args }) => resolveInvocation(run, command, args),
    renderUnknownCommand: (command) =>
      render(selected(unknownCommandError(command, argv, registry)), mode) + "\n",
    // G3: structured fields, the `error, code, <fields>, help` order, and exit codes.
    formatError: (error) => renderError(error, mode, device),
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
  device: string | undefined,
  produceOutput: () => Promise<Output>,
): Promise<void> {
  try {
    stdout.write(`${render(await produceOutput(), mode)}\n`);
  } catch (error) {
    writeError(stdout, error, mode, device);
  }
}

function writeError(
  stdout: { write: (chunk: string) => unknown },
  error: unknown,
  mode: OutputMode,
  device: string | undefined,
): void {
  const formatted = renderError(error, mode, device);
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

/** The `--device` / `-s` value given before any `--`, which the command's help lines repeat. */
export function selectedDevice(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? "";
    if (token === "--") return undefined;
    if (token === "--device" || token === "-s") {
      const value = argv[i + 1];
      return value === undefined || value === "" || value.startsWith("-") ? undefined : value;
    }
    if (token.startsWith("--device=")) {
      const value = token.slice("--device=".length);
      return value === "" ? undefined : value;
    }
  }
  return undefined;
}

/**
 * Whether the arguments are only global flags, which the home view takes as any command
 * does: `adb-axi --device emulator-5556`. Their values are checked when they are parsed.
 */
function isHomeFlags(argv: readonly string[]): boolean {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? "";
    if (VALUE_FLAGS.has(token)) {
      i++;
    } else if (token !== "--debug" && !/^--(?:device|timeout)=/.test(token)) {
      return false;
    }
  }
  return argv.length > 0;
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
  // Whether the last flag is one adb-axi does not know, so the word after it may be its value.
  let unknownLast = false;
  let i = 0;
  while (i < argv.length) {
    const token = argv[i] ?? "";
    if (!token.startsWith("-") || token === "--") break;
    const value = argv[i + 1];
    if (VALUE_FLAGS.has(token) && value !== undefined) {
      leading.push(token === "-s" ? "--device" : token, value);
      i += 2;
      unknownLast = false;
    } else {
      leading.push(token);
      i += 1;
      unknownLast = token !== "--debug" && !/^--(?:device|timeout)=/.test(token);
    }
  }
  const rest = argv.slice(i);
  if (rest.length === 0 || (unknownLast && registry.entries[rest[0] ?? ""] === undefined)) {
    // No command follows: only the global flags work alone (they go to the home view).
    return new AdbAxiError("VALIDATION_ERROR", `\`${argv.join(" ")}\` needs a command to go with`, {
      help: [
        runHint(["<command>", ...argv.map((token) => (token === "-s" ? "--device" : token))]),
        runHint(["--help"], "for every command and its summary"),
      ],
    });
  }
  const shown = argv.slice(0, i).join(" ");
  const message = `\`${shown}\` must come after the command`;

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

function unknownCommandError(command: string, argv: readonly string[], registry: Registry): Output {
  const shipped = shippedEntryNames(registry);
  const guess = closest(command, shipped);
  const rest = argv.slice(argv.indexOf(command) + 1);
  const help = [
    ...(guess === undefined
      ? []
      : [runHint([guess, ...rest], `if \`${command}\` was meant to be \`${guess}\``)]),
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
 * Walk from the top-level command to one leaf, validate its arguments, decide whether this
 * is a help request, and resolve the target device before the handler runs.
 */
async function resolveInvocation(
  run: Run,
  command: string | undefined,
  args: readonly string[],
): Promise<Invocation> {
  if (command === undefined) {
    return leafInvocation(run, run.registry.home, args);
  }
  const entry = run.registry.entries[command];
  if (entry === undefined) {
    throw new Error(`No registry entry for dispatched command ${command}`);
  }
  if (entry.kind === "command") {
    return leafInvocation(run, entry, args);
  }
  return groupInvocation(run, entry, args);
}

async function groupInvocation(
  run: Run,
  group: GroupSpec,
  args: readonly string[],
): Promise<Invocation> {
  const first = args[0];
  const sub = group.subcommands.find((command) => command.path[1] === first);
  if (sub) {
    return leafInvocation(run, sub, args.slice(1));
  }
  const helpForGroup = (): Output => {
    if (!isVisible(group)) throw notAvailable([group.name]);
    return groupHelp(group);
  };

  const flagOrNothing = first === undefined || first.startsWith("-");
  const defaultCommand = group.defaultCommand;
  if (defaultCommand && (flagOrNothing || defaultCommand.positionals.length > 0)) {
    return leafInvocation(run, defaultCommand, args, helpForGroup);
  }
  if (first === undefined || args.includes("--help")) {
    return { kind: "output", output: helpForGroup() };
  }
  if (!isVisible(group)) throw notAvailable([group.name]);
  if (!first.startsWith("-")) throw unknownSubcommand(group, first, args.slice(1));

  // Flags before the subcommand: say where the subcommand goes.
  const word = args.find((token) => group.subcommands.some((s) => s.path[1] === token));
  const corrected =
    word === undefined
      ? [group.name, "<subcommand>", ...args]
      : [group.name, word, ...args.filter((token) => token !== word)];
  throw new AdbAxiError(
    "VALIDATION_ERROR",
    `\`${commandLine([group.name])}\` needs a subcommand before its flags`,
    { fields: { subcommands: subcommandNames(group) }, help: [runHint(corrected)] },
  );
}

async function leafInvocation(
  run: Run,
  spec: CommandSpec,
  args: readonly string[],
  help: () => Output = () => commandHelp(spec),
): Promise<Invocation> {
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
  const timeoutMs = typeof timeout === "number" ? timeout : spec.defaultTimeoutMs;
  const debug = parsed.flags.debug === true;
  const deadline = new Deadline(timeoutMs);
  let client: AdbClient | undefined;
  const adb = (): AdbClient =>
    (client ??= new AdbClient(locateAdb(run.env), { debug, env: run.env }));

  const device = parsed.flags.device;
  const target =
    spec.device === "target"
      ? await resolveTarget({
          adb: adb(),
          deadline,
          env: run.env,
          requested: typeof device === "string" ? device : undefined,
          commandArgs: [...spec.path, ...withoutDeviceFlag(args)],
          isShipped: (path) => isShippedPath(run.registry, path),
        })
      : undefined;

  return {
    kind: "run",
    context: {
      spec,
      flags: parsed.flags,
      positionals: parsed.positionals,
      mode: run.mode,
      timeoutMs,
      debug,
      deadline,
      adb,
      target,
      env: run.env,
      hostProcesses: run.hostProcesses,
      isShipped: (path) => isShippedPath(run.registry, path),
    },
  };
}

/**
 * The typed arguments minus any device selection, for help lines that add their own.
 * What follows `--` is the remote command, shown as a placeholder: anything typed after
 * it, flags included, goes to the device, so echoing it would repeat a misplaced flag.
 */
function withoutDeviceFlag(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i] ?? "";
    if (token === "--") {
      out.push("--", "'<command>'");
      break;
    }
    if (token === "-s" || token === "--device") {
      i++;
      continue;
    }
    if (token.startsWith("--device=")) continue;
    out.push(token);
  }
  return out;
}

function subcommandNames(group: GroupSpec): string[] {
  return visibleSubcommands(group).map((command) => command.path[1] ?? "");
}

function unknownSubcommand(group: GroupSpec, word: string, rest: readonly string[]): AdbAxiError {
  const names = subcommandNames(group);
  const guess = closest(word, names);
  return new AdbAxiError(
    "VALIDATION_ERROR",
    `unknown subcommand \`${word}\` for \`${commandLine([group.name])}\``,
    {
      fields: { subcommands: names },
      help: [
        ...(guess === undefined
          ? []
          : [runHint([group.name, guess, ...rest], `if \`${word}\` was meant to be \`${guess}\``)]),
        runHint([group.name, "--help"], "for its subcommands"),
      ],
    },
  );
}
