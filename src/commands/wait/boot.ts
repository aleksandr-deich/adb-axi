import { readBoot } from "../../android/boot.js";
import { Deadline } from "../../core/deadline.js";
import { AdbAxiError } from "../../core/errors.js";
import { noop, okLine, runHint } from "../../core/output.js";
import { MAX_INTERVAL_MS, poll } from "../../core/poll.js";
import { resolveTarget } from "../../device/resolve.js";
import { UNKNOWN } from "../app/shared.js";
import { defineCommand } from "../define.js";

/** One look at the device: adb's state word and what the device says about its boot. */
interface BootObservation {
  state: string;
  boot_completed: number | typeof UNKNOWN;
  uptime_s: number | typeof UNKNOWN;
}

/** A single look may take this long, so one stalled device call cannot use up the whole wait. */
const OBSERVATION_CAP_MS = 5_000;

export const waitBoot = defineCommand({
  path: ["wait", "boot"],
  summary: "Wait until the device is online and has finished booting",
  defaultTimeoutMs: 120_000,
  // A booting emulator is offline or not attached yet, which is what this command waits out,
  // so the device is looked up again on every look instead of being checked up front.
  device: "none",
  examples: ["adb-axi wait boot", "adb-axi wait boot --device emulator-5556 --timeout 120s"],
  shipped: true,
  run: async (context) => {
    const adb = context.adb();
    const flag = context.flags.device;
    const requested = typeof flag === "string" ? flag : undefined;

    let serial: string | undefined;
    let latest: BootObservation | undefined;
    const result = await poll({
      timeoutMs: context.deadline.remainingMs(),
      check: async (remainingMs) => {
        // The final look, taken at the deadline, still gets a short deadline of its own.
        const deadline = new Deadline(
          Math.max(MAX_INTERVAL_MS, Math.min(remainingMs, OBSERVATION_CAP_MS)),
        );
        try {
          const target = await resolveTarget({
            adb,
            deadline,
            env: context.env,
            requested: serial ?? requested,
            commandArgs: ["wait", "boot"],
            isShipped: context.isShipped,
          });
          serial = target.serial;
          const boot = await readBoot(adb, target.serial, { deadline });
          latest = {
            state: "device",
            boot_completed: boot.bootCompleted ? 1 : 0,
            uptime_s: boot.uptimeS ?? UNKNOWN,
          };
          return boot.bootCompleted ? { done: true, value: latest } : { done: false, last: latest };
        } catch (error) {
          const seen = observationFromError(error, serial);
          if (seen === undefined) throw error;
          latest = seen;
          return { done: false, last: latest };
        }
      },
    });

    const who = serial ?? requested ?? (context.env.ANDROID_SERIAL || undefined);
    if (!result.ok) {
      throw new AdbAxiError(
        "WAIT_TIMEOUT",
        `${who ?? "the device"} had not finished booting after ${formatDuration(context.timeoutMs)}`,
        {
          fields: {
            last: latest ?? { state: "unknown", boot_completed: UNKNOWN, uptime_s: UNKNOWN },
          },
          help: context.isShipped(["doctor"])
            ? [runHint(who === undefined ? ["doctor"] : ["doctor", "--device", who], "to see why")]
            : [],
        },
      );
    }
    const target = serial ?? "device";
    return {
      ok: okLine(
        "wait boot",
        target,
        result.attempts === 1 ? noop("already booted") : `booted after ${result.waitedMs} ms`,
      ),
      waited_ms: result.waitedMs,
    };
  },
});

/**
 * What a look that could not read the boot says, when it is something a booting device does:
 * not attached yet, offline, or not answering. Anything else (an unauthorized device, an
 * ambiguous selection, an unreachable server) will not clear by waiting and ends the wait.
 */
function observationFromError(
  error: unknown,
  serial: string | undefined,
): BootObservation | undefined {
  if (!(error instanceof AdbAxiError)) return undefined;
  const unread = { boot_completed: UNKNOWN, uptime_s: UNKNOWN } as const;
  switch (error.code) {
    case "DEVICE_NOT_FOUND": {
      const devices = error.fields.devices;
      if (error.message === "no attached device is online" && Array.isArray(devices)) {
        const state = devices.every((device: { state: string }) => device.state === "offline")
          ? "offline"
          : "not online";
        return { state, ...unread };
      }
      return { state: "not attached", ...unread };
    }
    case "DEVICE_OFFLINE": {
      const state = error.fields.state;
      return { state: typeof state === "string" ? state : "offline", ...unread };
    }
    case "TIMEOUT":
      return { state: serial === undefined ? "unknown" : "device", ...unread };
    default:
      return undefined;
  }
}

function formatDuration(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`;
}
