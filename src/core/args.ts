import { AdbAxiError } from "./errors.js";
import { commandLine, runHint } from "./output.js";

export type FlagType = "boolean" | "string" | "duration" | "enum";

export interface FlagSpec {
  /** Long name including dashes, for example `--pkg`. */
  name: `--${string}`;
  /** Optional short alias, for example `-s`. */
  alias?: `-${string}`;
  type: FlagType;
  /** Allowed values for `enum` flags. */
  values?: readonly string[];
  /** How the value is shown in help, for example `<pkg>`. Ignored for booleans. */
  valueName?: string;
  description: string;
  /** Default as shown in help. */
  default?: string;
  required?: boolean;
}

export interface PositionalSpec {
  name: string;
  description: string;
  required: boolean;
  /** Collects every remaining argument (only valid as the last positional). */
  rest?: boolean;
}

export type FlagValue = string | number | boolean;

export interface ParsedArgs {
  /** Flag values keyed by long name without dashes. Durations are milliseconds. */
  flags: Record<string, FlagValue>;
  /** Positional values keyed by name. A `rest` positional is an array. */
  positionals: Record<string, string | string[]>;
  help: boolean;
}

export interface ArgsSpec {
  /** Command path used in messages, for example `["app", "start"]`. */
  path: readonly string[];
  flags: readonly FlagSpec[];
  positionals: readonly PositionalSpec[];
  /** Whether `--help` output exists for this command, so errors may point at it. */
  helpAvailable: boolean;
}

/** Flags every command accepts (7.1). `--help` is always allowed on top of these. */
export const GLOBAL_FLAGS: readonly FlagSpec[] = [
  {
    name: "--device",
    alias: "-s",
    type: "string",
    valueName: "<serial|avd>",
    description: "Target device by serial or AVD name",
  },
  {
    name: "--timeout",
    type: "duration",
    valueName: "<dur>",
    description: "Deadline for the whole command, for example 500ms, 30s or 5m",
  },
  { name: "--json", type: "boolean", description: "Print the same data as JSON" },
  { name: "--debug", type: "boolean", description: "Print the underlying adb calls on stderr" },
];

const DURATION = /^(\d+)(ms|s|m)$/;
const DURATION_UNITS = { ms: 1, s: 1000, m: 60_000 } as const;

/** Parse `500ms`, `30s` or `5m` into milliseconds; `undefined` when it is not a duration. */
export function parseDuration(text: string): number | undefined {
  const match = DURATION.exec(text);
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  const ms = Number(match[1]) * DURATION_UNITS[match[2] as keyof typeof DURATION_UNITS];
  return Number.isSafeInteger(ms) && ms > 0 ? ms : undefined;
}

export function flagUsage(flag: FlagSpec): string {
  if (flag.type === "boolean") return flag.name;
  const value = flag.valueName ?? (flag.values ? `<${flag.values.join("|")}>` : "<value>");
  return `${flag.name} ${value}`;
}

export function allFlags(spec: Pick<ArgsSpec, "flags">): FlagSpec[] {
  return [...spec.flags, ...GLOBAL_FLAGS];
}

/**
 * Strict parse of one command's arguments. Unknown flags, missing values, bad values,
 * repeated flags, missing positionals and extra positionals all fail with exit 2
 * `VALIDATION_ERROR` before any device is touched. After `--`, everything is positional.
 */
export function parseArgs(tokens: readonly string[], spec: ArgsSpec): ParsedArgs {
  const flags = allFlags(spec);
  const byName = new Map<string, FlagSpec>();
  for (const flag of flags) {
    byName.set(flag.name, flag);
    if (flag.alias) byName.set(flag.alias, flag);
  }

  const values: Record<string, FlagValue> = {};
  const positionalTokens: string[] = [];
  let help = false;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? "";
    if (token === "--") {
      positionalTokens.push(...tokens.slice(i + 1));
      break;
    }
    if (token === "--help") {
      help = true;
      continue;
    }
    if (!token.startsWith("-") || token === "-") {
      positionalTokens.push(token);
      continue;
    }

    const eq = token.startsWith("--") ? token.indexOf("=") : -1;
    const name = eq === -1 ? token : token.slice(0, eq);
    const flag = byName.get(name);
    if (!flag) {
      throw unknownFlag(name, spec, flags);
    }
    const key = flag.name.slice(2);
    if (Object.hasOwn(values, key)) {
      throw validation(`${flag.name} was given more than once`, []);
    }

    if (flag.type === "boolean") {
      if (eq !== -1) {
        throw validation(`${flag.name} takes no value`, [
          runHint([...spec.path, flag.name], "without a value"),
        ]);
      }
      values[key] = true;
      continue;
    }

    let raw: string | undefined;
    if (eq !== -1) {
      raw = token.slice(eq + 1);
    } else {
      raw = tokens[i + 1];
      if (raw === undefined || (raw.startsWith("-") && raw !== "-" && !isNegativeNumber(raw))) {
        raw = undefined;
      } else {
        i++;
      }
    }
    if (raw === undefined || raw === "") {
      throw validation(`${flag.name} needs a value`, [`Pass it as \`${flagUsage(flag)}\``]);
    }
    values[key] = convert(flag, raw);
  }

  if (help) {
    return { flags: values, positionals: {}, help: true };
  }

  for (const flag of flags) {
    if (flag.required === true && !Object.hasOwn(values, flag.name.slice(2))) {
      throw validation(`${flag.name} is required for \`${commandLine(spec.path)}\``, [
        `Pass it as \`${flagUsage(flag)}\``,
      ]);
    }
  }

  return { flags: values, positionals: bindPositionals(positionalTokens, spec), help: false };
}

function isNegativeNumber(text: string): boolean {
  return /^-\d/.test(text);
}

function convert(flag: FlagSpec, raw: string): FlagValue {
  switch (flag.type) {
    case "duration": {
      const ms = parseDuration(raw);
      if (ms === undefined) {
        throw validation(`${flag.name} value "${raw}" is not a duration`, [
          `Use a whole number with ms, s or m, for example \`${flag.name} 30s\``,
        ]);
      }
      return ms;
    }
    case "enum": {
      const allowed = flag.values ?? [];
      if (!allowed.includes(raw)) {
        throw validation(
          `${flag.name} value "${raw}" is not one of ${allowed.join(", ")}`,
          [`Pass one of: ${allowed.map((v) => `\`${flag.name} ${v}\``).join(", ")}`],
          { valid_values: [...allowed] },
        );
      }
      return raw;
    }
    case "string":
    case "boolean":
      return raw;
  }
}

function bindPositionals(tokens: readonly string[], spec: ArgsSpec): ParsedArgs["positionals"] {
  const bound: ParsedArgs["positionals"] = {};
  let index = 0;
  for (const positional of spec.positionals) {
    if (positional.rest === true) {
      const rest = tokens.slice(index);
      index = tokens.length;
      if (positional.required && rest.length === 0) throw missing(positional, spec);
      if (rest.length > 0) bound[positional.name] = rest;
      continue;
    }
    const value = tokens[index];
    if (value === undefined) {
      if (positional.required) throw missing(positional, spec);
      continue;
    }
    bound[positional.name] = value;
    index++;
  }
  const extra = tokens[index];
  if (extra !== undefined) {
    throw validation(`unexpected argument "${extra}" for \`${commandLine(spec.path)}\``, [
      `Run \`${usageLine(spec)}\``,
    ]);
  }
  return bound;
}

export function usageLine(spec: Pick<ArgsSpec, "path" | "positionals">): string {
  const args = spec.positionals.map((p) => {
    const name = p.rest === true ? `<${p.name}>...` : `<${p.name}>`;
    return p.required ? name : `[${name}]`;
  });
  return [commandLine(spec.path), ...args, "[flags]"].join(" ");
}

function missing(positional: PositionalSpec, spec: ArgsSpec): AdbAxiError {
  return validation(`missing <${positional.name}> for \`${commandLine(spec.path)}\``, [
    `Run \`${usageLine(spec)}\``,
  ]);
}

function unknownFlag(name: string, spec: ArgsSpec, flags: readonly FlagSpec[]): AdbAxiError {
  const command = commandLine(spec.path);
  const guess = closestFlag(name, flags);
  const message =
    guess === undefined
      ? `unknown flag ${name} for \`${command}\``
      : `unknown flag ${name} for \`${command}\`; did you mean ${guess}?`;
  const help = spec.helpAvailable ? [runHint([...spec.path, "--help"], "for flag details")] : [];
  return validation(message, help, {
    valid_flags: [...flags.map(flagUsage), "--help"],
  });
}

function validation(
  message: string,
  help: readonly string[],
  fields: Record<string, unknown> = {},
): AdbAxiError {
  return new AdbAxiError("VALIDATION_ERROR", message, { fields, help });
}

/** The known flag nearest to a mistyped one, when it is close enough to be a typo. */
function closestFlag(name: string, flags: readonly FlagSpec[]): string | undefined {
  let best: { name: string; distance: number } | undefined;
  for (const flag of flags) {
    const distance = editDistance(name, flag.name);
    if (distance <= 2 && (best === undefined || distance < best.distance)) {
      best = { name: flag.name, distance };
    }
  }
  return best?.name;
}

export function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0] ?? 0;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j] ?? 0;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(above + 1, (row[j - 1] ?? 0) + 1, diagonal + cost);
      diagonal = above;
    }
  }
  return row[b.length] ?? 0;
}
