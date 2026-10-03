import { runShell } from "../adb/shell.js";
import type { AdbClient } from "../adb/run.js";
import type { Deadline } from "../core/deadline.js";
import type { DeviceFacts } from "./facts.js";
import { FACTS_CAP_MS } from "./facts.js";
import type { AttachedDevice } from "./list.js";
import { ONLINE } from "./list.js";

/** The optional `devices --fields` columns, in the order they are printed. */
export const EXTRA_FIELDS = ["boot", "data_free", "model", "abi", "uptime"] as const;
export type ExtraField = (typeof EXTRA_FIELDS)[number];

/** Device-side commands for the columns that need them (`boot` comes with the base facts). */
const SOURCES: Partial<Record<ExtraField, string>> = {
  model: "getprop ro.product.model",
  abi: "getprop ro.product.cpu.abi",
  data_free: "df -k /data",
  uptime: "cat /proc/uptime",
};

/** The values of the requested extra columns; `-` is unknown. */
export type ExtraValues = Record<ExtraField, string>;

/**
 * Read the requested extra columns of one device. One shell call reads every source, each
 * introduced by an `@name` marker line so one failing command cannot shift the others.
 * Offline devices only have what `adb devices -l` says (the model); the rest is unknown.
 */
export async function readExtraFields(
  adb: AdbClient,
  device: AttachedDevice,
  facts: DeviceFacts,
  fields: readonly ExtraField[],
  options: { deadline: Deadline },
): Promise<Partial<ExtraValues>> {
  const wanted = fields.filter((field) => SOURCES[field] !== undefined);
  if (device.state !== ONLINE || wanted.length === 0) return extraValues(device, facts, fields);
  const script = wanted.map((field) => `echo @${field}; ${SOURCES[field] ?? ""}`).join("; ");
  const result = await runShell(adb, device.serial, script, {
    deadline: options.deadline,
    step: `reading ${wanted.join(", ")} of ${device.serial}`,
    capMs: FACTS_CAP_MS,
  });
  return extraValues(device, facts, fields, splitSections(result.stdout));
}

/**
 * The extra columns from what is already known (`boot` from the facts, `model` from
 * `adb devices -l`) and the device's own answers, if any; the rest is unknown.
 */
export function extraValues(
  device: AttachedDevice,
  facts: DeviceFacts,
  fields: readonly ExtraField[],
  sections: ReadonlyMap<string, readonly string[]> = new Map(),
): Partial<ExtraValues> {
  const values: Partial<ExtraValues> = {};
  for (const field of fields) {
    const lines = sections.get(field) ?? [];
    switch (field) {
      case "boot":
        values.boot =
          facts.bootCompleted === null ? "-" : facts.bootCompleted ? "completed" : "booting";
        break;
      case "model":
        values.model = lines[0] ?? device.props.model ?? "-";
        break;
      case "abi":
        values.abi = lines[0] ?? "-";
        break;
      case "data_free":
        values.data_free = parseDataFree(lines);
        break;
      case "uptime":
        values.uptime = parseUptime(lines[0]);
        break;
    }
  }
  return values;
}

export function splitSections(stdout: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    const marker = /^@([a-z_]+)$/.exec(line);
    if (marker?.[1] !== undefined) {
      current = [];
      sections.set(marker[1], current);
    } else if (current && line !== "") {
      current.push(line);
    }
  }
  return sections;
}

/**
 * Free space on /data from `df -k /data`: the `Available` column of the last line, read
 * from the right because the filesystem name may be anything.
 */
export function parseDataFree(lines: readonly string[]): string {
  const last = lines.at(-1);
  if (last === undefined || lines.length < 2) return "-";
  const available = Number(last.split(/\s+/).at(-3));
  return Number.isFinite(available) && available >= 0 ? formatSize(available * 1024) : "-";
}

/** `33224.41 114569.60` (seconds up, seconds idle) as `9h13m`. */
export function parseUptime(line: string | undefined): string {
  const seconds = Math.floor(Number(line?.split(/\s+/)[0]));
  return Number.isFinite(seconds) && seconds >= 0 ? formatUptime(seconds) : "-";
}

export function formatUptime(seconds: number): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d${pad(hours)}h`;
  if (hours > 0) return `${hours}h${pad(minutes)}m`;
  if (minutes > 0) return `${minutes}m${pad(seconds % 60)}s`;
  return `${seconds}s`;
}

/** Bytes as `21.4G`, `512M` or `96K`. */
export function formatSize(bytes: number): string {
  const gib = 1024 ** 3;
  const mib = 1024 ** 2;
  if (bytes >= gib) return `${(bytes / gib).toFixed(1)}G`;
  if (bytes >= mib) return `${Math.round(bytes / mib)}M`;
  return `${Math.round(bytes / 1024)}K`;
}
