import { app } from "./app/index.js";
import { data } from "./data/index.js";
import { devices } from "./devices.js";
import { doctor } from "./doctor/index.js";
import { home } from "./home.js";
import { logs } from "./logs/index.js";
import { shell } from "./shell.js";
import type { CommandSpec, GroupSpec, Registry, RegistryEntry } from "./types.js";
import { update } from "./update.js";
import { wait } from "./wait/index.js";

/** The single registry of every v0.1 command. Help and suggestions list only shipped ones. */
export const REGISTRY: Registry = {
  home,
  entries: { devices, doctor, wait, app, logs, data, shell, update },
};

/** Every command in a registry entry, including a group's default command. */
export function entryCommands(entry: RegistryEntry): CommandSpec[] {
  if (entry.kind === "command") return [entry];
  return entry.defaultCommand
    ? [entry.defaultCommand, ...entry.subcommands]
    : [...entry.subcommands];
}

export function allCommands(registry: Registry): CommandSpec[] {
  return Object.values(registry.entries).flatMap(entryCommands);
}

export function isVisible(entry: RegistryEntry): boolean {
  return entryCommands(entry).some((command) => command.shipped);
}

export function visibleSubcommands(group: GroupSpec): CommandSpec[] {
  return group.subcommands.filter((command) => command.shipped);
}

export function shippedEntryNames(registry: Registry): string[] {
  return Object.entries(registry.entries)
    .filter(([, entry]) => isVisible(entry))
    .map(([name]) => name);
}
