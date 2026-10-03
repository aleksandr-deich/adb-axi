import { isShippedPath, isVisible, REGISTRY } from "../../src/commands/registry.js";
import type { CommandSpec } from "../../src/commands/types.js";
import { GLOBAL_FLAGS } from "../../src/core/args.js";

/** v0.2 verbs that no help line may name before v0.2 ships them (6.3). */
export const V02_PATTERNS = [
  /adb-axi lease\b/,
  /adb-axi config\b/,
  /adb-axi fwd\b/,
  /adb-axi rev\b/,
  /adb-axi data prefs\b/,
  /adb-axi doctor --fix\b/,
  /adb-axi setup\b/,
];

/**
 * Every `adb-axi ...` command line quoted in `value` (any string, nested anywhere) that
 * this build could not run as written: a command it does not ship, or a flag that command
 * does not take. Placeholders such as `<command>` and `<subcommand>` stand for any.
 */
export function unrunnableCommands(value: unknown): string[] {
  return strings(value).flatMap((text) => {
    const bad: string[] = [];
    for (const match of text.matchAll(/`(adb-axi(?: [^`]*)?)`/g)) {
      const line = match[1] ?? "";
      if (!runnable(line.split(" ").slice(1)) || V02_PATTERNS.some((p) => p.test(line))) {
        bad.push(line);
      }
    }
    return bad;
  });
}

function runnable(words: readonly string[]): boolean {
  const [first, second] = words;
  if (first === undefined || first.startsWith("-")) return true;
  if (first === "<command>") return true;
  const entry = REGISTRY.entries[first];
  if (entry === undefined || !isVisible(entry)) return false;
  let spec: CommandSpec | undefined;
  if (entry.kind === "command") {
    spec = entry;
  } else {
    if (second === "<subcommand>") return true;
    spec = entry.subcommands.find((sub) => sub.path[1] === second) ?? entry.defaultCommand;
    if (spec === undefined) return words.slice(1).every((word) => word === "--help");
  }
  if (!isShippedPath(REGISTRY, spec.path)) return false;
  const end = words.indexOf("--");
  const flags = (end === -1 ? words : words.slice(0, end)).filter((word) => word.startsWith("-"));
  const known = new Set<string>(["--help"]);
  for (const flag of [...spec.flags, ...GLOBAL_FLAGS]) {
    known.add(flag.name);
    if (flag.alias !== undefined) known.add(flag.alias);
  }
  return flags.every((flag) => known.has(flag.split("=")[0] ?? flag));
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(strings);
  return [];
}
