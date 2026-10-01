import { join } from "node:path";
import { runShell } from "../adb/shell.js";
import type { AdbClient } from "../adb/run.js";
import type { Deadline } from "../core/deadline.js";
import { AdbAxiError } from "../core/errors.js";
import { deviceStateDir, readJson, writeJsonAtomic } from "../core/state.js";
import { ONLINE, type AttachedDevice } from "./list.js";

export type Form = "phone" | "tablet";

/** Facts agents kept fetching separately. `null` means unknown (printed as `-`). */
export interface DeviceFacts {
  serial: string;
  state: string;
  avd: string | null;
  api: number | null;
  form: Form | null;
  smallestWidthDp: number | null;
  bootCompleted: boolean | null;
  bootId: string | null;
}

/** Smallest screen width at and above which a device reads as a tablet. */
export const TABLET_MIN_DP = 600;

/** Cap for one facts read, below the command deadline, so one slow device cannot eat it. */
export const FACTS_CAP_MS = 10_000;

/**
 * One shell call reads everything the device can tell about itself; each section is
 * introduced by an `@name` marker line so one failing command cannot shift the others.
 */
const FACTS_SCRIPT = [
  "echo @sdk",
  "getprop ro.build.version.sdk",
  "echo @boot_completed",
  "getprop sys.boot_completed",
  "echo @boot_id",
  "cat /proc/sys/kernel/random/boot_id",
  "echo @size",
  "wm size",
  "echo @density",
  "wm density",
].join("; ");

export interface FactsOptions {
  deadline: Deadline;
  env?: NodeJS.ProcessEnv;
}

/**
 * Read one attached device's facts. Offline or unauthorized devices only get what
 * `adb devices` says; for emulators the AVD name is still tried, since the emulator
 * console answers even when adb does not.
 */
export async function readFacts(
  adb: AdbClient,
  device: AttachedDevice,
  options: FactsOptions,
): Promise<DeviceFacts> {
  const facts = await readShellFacts(adb, device, options);
  facts.avd = await avdName(adb, device.serial, facts.bootId, options);
  return facts;
}

/** Every fact but the AVD name: what the device's own shell tells, when it is online. */
export async function readShellFacts(
  adb: AdbClient,
  device: AttachedDevice,
  options: FactsOptions,
): Promise<DeviceFacts> {
  const facts: DeviceFacts = {
    serial: device.serial,
    state: device.state,
    avd: null,
    api: null,
    form: null,
    smallestWidthDp: null,
    bootCompleted: null,
    bootId: null,
  };
  if (device.state === ONLINE) {
    const shell = await runShell(adb, device.serial, FACTS_SCRIPT, {
      deadline: options.deadline,
      step: `reading facts of ${device.serial}`,
      capMs: FACTS_CAP_MS,
    });
    Object.assign(facts, parseFacts(shell.stdout));
  }
  return facts;
}

type ParsedFacts = Pick<
  DeviceFacts,
  "api" | "form" | "smallestWidthDp" | "bootCompleted" | "bootId"
>;

export function parseFacts(stdout: string): ParsedFacts {
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
  const first = (name: string): string | undefined => sections.get(name)?.[0];

  const sdk = Number(first("sdk"));
  const bootFlag = first("boot_completed");
  const bootId = first("boot_id");
  const size = effective(sections.get("size") ?? [], /^(Physical|Override) size: (\d+)x(\d+)$/);
  const density = effective(sections.get("density") ?? [], /^(Physical|Override) density: (\d+)$/);

  let smallestWidthDp: number | null = null;
  if (size && density) {
    const width = Number(size[2]);
    const height = Number(size[3]);
    const dpi = Number(density[2]);
    if (dpi > 0) smallestWidthDp = Math.floor((Math.min(width, height) * 160) / dpi);
  }
  return {
    api: Number.isInteger(sdk) && sdk > 0 ? sdk : null,
    bootCompleted: bootFlag === undefined ? null : bootFlag === "1",
    bootId: bootId !== undefined && /^[0-9a-f-]{8,}$/i.test(bootId) ? bootId : null,
    smallestWidthDp,
    form: formFor(smallestWidthDp),
  };
}

export function formFor(smallestWidthDp: number | null): Form | null {
  if (smallestWidthDp === null) return null;
  return smallestWidthDp >= TABLET_MIN_DP ? "tablet" : "phone";
}

/** An override (set by `wm size <WxH>`) wins over the physical value. */
function effective(lines: readonly string[], pattern: RegExp): RegExpExecArray | undefined {
  const matches = lines.map((line) => pattern.exec(line)).filter((m) => m !== null);
  return matches.find((m) => m[1] === "Override") ?? matches.find((m) => m[1] === "Physical");
}

interface AvdCache {
  boot_id: string;
  avd: string;
}

/**
 * The AVD name of an emulator, from `emu avd name`. Empty output or a non-zero exit (H6)
 * means unknown, never an error. Names are cached per serial and emulator boot, so a
 * different emulator started later on the same port is read again.
 */
export async function avdName(
  adb: AdbClient,
  serial: string,
  bootId: string | null,
  options: FactsOptions,
): Promise<string | null> {
  if (!serial.startsWith("emulator-")) return null;
  const cachePath = join(deviceStateDir(serial, options.env), "avd.json");
  if (bootId !== null) {
    const cached = readCache(cachePath);
    if (cached?.boot_id === bootId && typeof cached.avd === "string") return cached.avd;
  }

  let name: string | null;
  try {
    const result = await adb.device(serial, ["emu", "avd", "name"], {
      deadline: options.deadline,
      step: `reading the AVD name of ${serial}`,
      capMs: FACTS_CAP_MS,
    });
    name = result.exitCode === 0 ? parseAvdName(result.stdout.toString("utf8")) : null;
  } catch (error) {
    // A console that does not answer in time is a real failure; anything else (the
    // console refusing, the emulator going away) reads as an unknown AVD name.
    if (error instanceof AdbAxiError && error.code === "TIMEOUT") throw error;
    return null;
  }
  if (name !== null && bootId !== null) {
    writeJsonAtomic(cachePath, { boot_id: bootId, avd: name } satisfies AvdCache);
  }
  return name;
}

/** A cache that cannot be read is a miss, never a failure. */
function readCache(path: string): Partial<AvdCache> | undefined {
  try {
    const value = readJson(path);
    return typeof value === "object" && value !== null ? value : undefined;
  } catch {
    return undefined;
  }
}

/** `emu avd name` prints the name, then `OK`, with CRLF line ends. */
export function parseAvdName(stdout: string): string | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && line !== "OK");
  const name = lines[0];
  return name !== undefined && /^[\w.-]+$/.test(name) ? name : null;
}
