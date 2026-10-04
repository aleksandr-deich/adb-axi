import { AdbAxiError } from "../core/errors.js";
import { runHint, type Output } from "../core/output.js";
import { EXTRA_FIELDS, extraValues, readExtraFields, type ExtraField } from "../device/columns.js";
import type { AdbClient } from "../adb/run.js";
import {
  avdName,
  lastKnownAvd,
  lastKnownLabel,
  readShellFacts,
  type DeviceFacts,
  type FactsOptions,
} from "../device/facts.js";
import { listDevices, ONLINE, type AttachedDevice } from "../device/list.js";
import { defineCommand } from "./define.js";
import type { CommandContext } from "./types.js";

/** States listed without `--all`. Everything else (recovery, sideload, ...) is unusual. */
export const USUAL_STATES = new Set([ONLINE, "offline", "unauthorized", "no permissions"]);

/** Errors of one device's own reads; they leave its facts unknown instead of failing the list. */
const PER_DEVICE_CODES = new Set([
  "TIMEOUT",
  "DEVICE_NOT_FOUND",
  "DEVICE_OFFLINE",
  "DEVICE_UNAUTHORIZED",
]);

export const devices = defineCommand({
  path: ["devices"],
  summary: "Every attached device with its AVD name, state, API level and form",
  device: "none",
  shipped: true,
  flags: [
    {
      name: "--all",
      type: "boolean",
      description: "Include devices in unusual states such as recovery or sideload",
    },
    {
      name: "--fields",
      type: "string",
      valueName: "<list>",
      description: `Extra comma-separated columns: ${EXTRA_FIELDS.join(", ")}`,
    },
  ],
  examples: ["adb-axi devices", "adb-axi devices --fields model,abi"],
  run: runDevices,
});

export interface Row {
  device: AttachedDevice;
  facts: DeviceFacts;
  extra: Partial<Record<ExtraField, string>>;
  /** Some of the device's own reads failed, so what they would have told is unknown. */
  degraded: boolean;
}

async function runDevices(context: CommandContext): Promise<Output> {
  const fields = parseFields(context.flags.fields);
  const adb = context.adb();
  const attached = await listDevices(adb, context.deadline);
  const listed =
    context.flags.all === true
      ? attached
      : attached.filter((device) => USUAL_STATES.has(device.state));

  const options = { deadline: context.deadline, env: context.env };
  const rows = await Promise.all(listed.map((device) => readRow(adb, device, fields, options)));

  const online = rows.filter((row) => row.device.state === ONLINE).length;
  const hidden = attached.length - listed.length;
  return {
    count: `${rows.length} attached, ${online} online${
      hidden > 0 ? ` (${hidden} in other states, use --all)` : ""
    }`,
    ...(hidden > 0 ? { other_states: hidden } : {}),
    devices: rows.map((row) => deviceRow(row, fields)),
    ...helpFor(rows, attached.length, context),
  };
}

/**
 * One device's row. When the shell facts fail, the device is not answering and nothing
 * else is asked; the AVD name and the extra columns are separate reads, and one failing
 * leaves only its own columns unknown.
 */
export async function readRow(
  adb: AdbClient,
  device: AttachedDevice,
  fields: readonly ExtraField[],
  options: FactsOptions,
): Promise<Row> {
  let degraded = false;
  const settle = async <T>(read: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await read();
    } catch (error) {
      if (error instanceof AdbAxiError && PER_DEVICE_CODES.has(error.code)) {
        degraded = true;
        return undefined;
      }
      throw error;
    }
  };

  const facts = await settle(() => readShellFacts(adb, device, options));
  if (facts === undefined) {
    const unknown = unknownFacts(device);
    return { device, facts: unknown, extra: extraValues(device, unknown, fields), degraded };
  }
  const [avd, extra] = await Promise.all([
    settle(() => avdName(adb, device.serial, facts.bootId, options)),
    settle(() => readExtraFields(adb, device, facts, fields, options)),
  ]);
  const last =
    device.state !== ONLINE && avd == null ? lastKnownAvd(device.serial, options.env) : null;
  return {
    device,
    facts: { ...facts, avd: avd ?? (last === null ? null : lastKnownLabel(last)) },
    extra: extra ?? extraValues(device, facts, fields),
    degraded,
  };
}

export function deviceRow(
  row: Row,
  fields: readonly ExtraField[],
): Record<string, string | number> {
  const { device, facts } = row;
  const base = {
    serial: device.serial,
    avd: facts.avd ?? "-",
    state: device.state,
    api: facts.api ?? "-",
    form: device.state === ONLINE ? (facts.form ?? "-") : "-",
  };
  const extra = Object.fromEntries(fields.map((field) => [field, row.extra[field] ?? "-"]));
  return { ...base, ...extra };
}

function unknownFacts(device: AttachedDevice): DeviceFacts {
  return {
    serial: device.serial,
    state: device.state,
    avd: null,
    api: null,
    form: null,
    smallestWidthDp: null,
    bootCompleted: null,
    bootId: null,
  };
}

function helpFor(
  rows: readonly Row[],
  attached: number,
  context: CommandContext,
): { help?: string[] } {
  const help: string[] = [];
  if (attached === 0) {
    help.push("Start an emulator or connect a device, then run `adb-axi devices` again");
  }
  // Only a name no other device shares, or following the hint fails with DEVICE_AMBIGUOUS.
  const named = rows.find(
    (row) =>
      row.device.state === ONLINE &&
      row.facts.avd !== null &&
      rows.filter((other) => other.facts.avd === row.facts.avd).length === 1,
  );
  if (named?.facts.avd) {
    help.push(runHint(["<command>", "--device", named.facts.avd], "to target one by AVD name"));
  }
  const stuck = rows.find((row) => row.device.state !== ONLINE);
  if (stuck) {
    if (context.isShipped(["doctor"])) {
      help.push(
        runHint(
          ["doctor", "--device", stuck.device.serial],
          `to see why it is ${stuck.device.state}`,
        ),
      );
    } else if (stuck.device.state === "unauthorized") {
      help.push("Accept the USB debugging prompt on the device to authorize this computer");
    }
  }
  if (rows.some((row) => row.degraded)) {
    help.push("A device that could not be read shows `-` for what it could not tell");
  }
  return help.length > 0 ? { help } : {};
}

/** `--fields model,abi` as a deduplicated list in column order; anything else is a usage error. */
function parseFields(value: unknown): ExtraField[] {
  if (typeof value !== "string") return [];
  const requested = value.split(",").map((name) => name.trim());
  const unknown = requested.filter((name) => !(EXTRA_FIELDS as readonly string[]).includes(name));
  if (unknown.length > 0) {
    throw new AdbAxiError(
      "VALIDATION_ERROR",
      `--fields has unknown ${unknown.length === 1 ? "column" : "columns"} ${unknown
        .map((name) => `"${name}"`)
        .join(", ")}`,
      {
        fields: { valid_values: [...EXTRA_FIELDS] },
        help: [runHint(["devices", "--fields", EXTRA_FIELDS.slice(0, 2).join(",")])],
      },
    );
  }
  return EXTRA_FIELDS.filter((field) => requested.includes(field));
}
