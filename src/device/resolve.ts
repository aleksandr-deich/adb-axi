import type { AdbClient } from "../adb/run.js";
import type { Deadline } from "../core/deadline.js";
import { AdbAxiError } from "../core/errors.js";
import { runHint } from "../core/output.js";
import { avdName, readFacts, type DeviceFacts } from "./facts.js";
import { listDevices, ONLINE, type AttachedDevice } from "./list.js";

export interface Target {
  serial: string;
  device: AttachedDevice;
  /** How the target was chosen, in the order of 7.2. */
  selectedBy: "flag" | "env" | "only-online";
}

export interface ResolveOptions {
  adb: AdbClient;
  deadline: Deadline;
  env: NodeJS.ProcessEnv;
  /** `--device` / `-s`: a serial or an AVD name. */
  requested: string | undefined;
  /** The command as typed, without any device flag, for help lines (`["logs", "--pkg", "x"]`). */
  commandArgs: readonly string[];
  /** Whether a command path ships in this build, so help never suggests one that does not (6.3). */
  isShipped: (path: readonly string[]) => boolean;
}

/**
 * Pick the one device a command acts on (7.2), first match wins: `--device` (serial, then
 * AVD name), `ANDROID_SERIAL`, the only online device. Anything else fails at once, and the
 * target's state is checked before any work so nothing can block on a missing device.
 */
export async function resolveTarget(options: ResolveOptions): Promise<Target> {
  const devices = await listDevices(options.adb, options.deadline);
  const fromEnv = options.env.ANDROID_SERIAL;
  const wanted = options.requested ?? (fromEnv === "" ? undefined : fromEnv);
  if (wanted !== undefined) {
    const selectedBy = options.requested === undefined ? "env" : "flag";
    return { ...(await byName(wanted, devices, options)), selectedBy };
  }

  const online = devices.filter((device) => device.state === ONLINE);
  const only = online[0];
  if (online.length === 1 && only) {
    return { serial: only.serial, device: only, selectedBy: "only-online" };
  }
  if (online.length > 1) {
    const facts = await Promise.all(online.map((device) => factsOrUnknown(device, options)));
    throw new AdbAxiError(
      "DEVICE_AMBIGUOUS",
      `${online.length} devices are online and none is selected`,
      {
        fields: { devices: facts.map(candidateRow) },
        help: [
          runHint(withDevice(options.commandArgs, "<serial or avd>")),
          "Or export ANDROID_SERIAL=<serial> in this shell",
        ],
      },
    );
  }

  const lone = devices[0];
  if (devices.length === 1 && lone) {
    checkState(lone, options);
  }
  throw new AdbAxiError(
    "DEVICE_NOT_FOUND",
    devices.length === 0 ? "no device is attached" : "no attached device is online",
    {
      fields:
        devices.length === 0
          ? {}
          : { devices: devices.map((d) => ({ serial: d.serial, state: d.state })) },
      help: ["Start an emulator or connect a device, then run the command again"],
    },
  );
}

async function byName(
  wanted: string,
  devices: readonly AttachedDevice[],
  options: ResolveOptions,
): Promise<Omit<Target, "selectedBy">> {
  const bySerial = devices.find((device) => device.serial === wanted);
  if (bySerial) {
    checkState(bySerial, options);
    return { serial: bySerial.serial, device: bySerial };
  }

  // Not a serial: try it as an AVD name. Only the emulator console is asked, which answers
  // even while the device itself is busy. A console that hangs is a TIMEOUT, not "no such AVD".
  const emulators = devices.filter((device) => device.serial.startsWith("emulator-"));
  const facts = { deadline: options.deadline, env: options.env };
  const names = await Promise.all(
    emulators.map(async (device) => ({
      device,
      avd: await avdName(options.adb, device.serial, null, facts),
    })),
  );
  const matches = names.filter((entry) => entry.avd === wanted).map((entry) => entry.device);
  const match = matches[0];
  if (matches.length === 1 && match) {
    checkState(match, options);
    return { serial: match.serial, device: match };
  }
  if (matches.length > 1) {
    const rows = await Promise.all(matches.map((device) => factsOrUnknown(device, options)));
    throw new AdbAxiError(
      "DEVICE_AMBIGUOUS",
      `${matches.length} running emulators use the AVD name ${wanted}`,
      {
        fields: { devices: rows.map((row) => candidateRow({ ...row, avd: wanted })) },
        help: [runHint(withDevice(options.commandArgs, "<serial>"), "to pick one by serial")],
      },
    );
  }

  const known = new Map(names.map((entry) => [entry.device.serial, entry.avd]));
  throw new AdbAxiError(
    "DEVICE_NOT_FOUND",
    `no attached device has the serial or AVD name ${wanted}`,
    {
      fields: {
        devices: devices.map((device) => ({
          serial: device.serial,
          avd: known.get(device.serial) ?? "-",
          state: device.state,
        })),
      },
      help:
        devices.length === 0
          ? ["Start the emulator or connect the device, then run the command again"]
          : [
              runHint(
                withDevice(options.commandArgs, "<serial or avd>"),
                "with one of the devices above",
              ),
            ],
    },
  );
}

/** The command line with `--device <value>` added before any `--`, which ends the flags. */
function withDevice(commandArgs: readonly string[], value: string): string[] {
  const end = commandArgs.indexOf("--");
  const flags = end === -1 ? commandArgs : commandArgs.slice(0, end);
  const rest = end === -1 ? [] : commandArgs.slice(end);
  return [...flags, "--device", value, ...rest];
}

/** Fail unless the device accepts commands. Returns nothing: an online device passes. */
function checkState(device: AttachedDevice, options: ResolveOptions): void {
  if (device.state === ONLINE) return;
  const doctor = options.isShipped(["doctor"])
    ? [runHint(["doctor", "--device", device.serial], "to see why")]
    : [];
  if (device.state === "unauthorized" || device.state === "no permissions") {
    throw new AdbAxiError(
      "DEVICE_UNAUTHORIZED",
      `${device.serial} has not authorized USB debugging from this computer`,
      {
        fields: { state: device.state },
        help: [
          "Accept the USB debugging prompt on the device, then run the command again",
          ...doctor,
        ],
      },
    );
  }
  const message =
    device.state === "offline"
      ? `${device.serial} is offline`
      : `${device.serial} is in state ${device.state}, not ready for commands`;
  throw new AdbAxiError("DEVICE_OFFLINE", message, {
    fields: { state: device.state },
    help: doctor,
  });
}

async function factsOrUnknown(
  device: AttachedDevice,
  options: ResolveOptions,
): Promise<DeviceFacts> {
  try {
    return await readFacts(options.adb, device, { deadline: options.deadline, env: options.env });
  } catch {
    // Candidates for an ambiguity error are best effort; the error is about selection.
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
}

function candidateRow(facts: DeviceFacts): { serial: string; avd: string; form: string } {
  return { serial: facts.serial, avd: facts.avd ?? "-", form: facts.form ?? "-" };
}
