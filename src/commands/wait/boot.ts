import { readBoot } from "../../android/boot.js";
import { Deadline } from "../../core/deadline.js";
import { AdbAxiError } from "../../core/errors.js";
import { noop, okLine, runHint } from "../../core/output.js";
import { MAX_INTERVAL_MS, poll } from "../../core/poll.js";
import { resolveTarget } from "../../device/resolve.js";
import { UNKNOWN } from "../app/shared.js";
import { defineCommand } from "../define.js";

/**
 * One look at the device: adb's state word, what the device says about its boot, and
 * whether the package and activity services answer (1 or 0).
 */
interface BootObservation {
  state: string;
  boot_completed: number | typeof UNKNOWN;
  uptime_s: number | typeof UNKNOWN;
  package_service: number | typeof UNKNOWN;
  activity_service: number | typeof UNKNOWN;
}

const UNREAD = {
  boot_completed: UNKNOWN,
  uptime_s: UNKNOWN,
  package_service: UNKNOWN,
  activity_service: UNKNOWN,
} as const;

/** A single look may take this long, so one stalled device call cannot use up the whole wait. */
const OBSERVATION_CAP_MS = 5_000;

/**
 * A device up for less than this may still restart `system_server`, which happens seconds
 * after `sys.boot_completed` on a fresh emulator; one up for longer is trusted on one look.
 */
const FRESH_UPTIME_S = 300;

/**
 * On a fresh device, how long the services must keep answering from the same `system_server`
 * before the wait ends. A restart inside it starts the count again from the new process.
 */
const SETTLE_MS = 10_000;

export const waitBoot = defineCommand({
  path: ["wait", "boot"],
  summary: "Wait until the device is online, booted, and able to install and launch apps",
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
    // The system_server pid that has answered since `since` (ms on the host clock).
    let settling: { pid: number; since: number } | undefined;
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
            package_service: flag01(boot.packageService),
            activity_service: flag01(boot.activityService),
          };
          if (
            !boot.bootCompleted ||
            boot.packageService !== true ||
            boot.activityService !== true ||
            boot.systemServerPid === null
          ) {
            settling = undefined;
            return { done: false, last: latest };
          }
          if (boot.uptimeS !== null && boot.uptimeS >= FRESH_UPTIME_S) {
            return { done: true, value: latest };
          }
          const now = performance.now();
          if (settling?.pid !== boot.systemServerPid) {
            settling = { pid: boot.systemServerPid, since: now };
          }
          return now - settling.since >= SETTLE_MS
            ? { done: true, value: latest }
            : { done: false, last: latest };
        } catch (error) {
          const seen = observationFromError(error, serial);
          if (seen === undefined) throw error;
          latest = seen;
          settling = undefined;
          return { done: false, last: latest };
        }
      },
    });

    const who = serial ?? requested ?? (context.env.ANDROID_SERIAL || undefined);
    if (!result.ok) {
      const after = formatDuration(context.timeoutMs);
      throw new AdbAxiError(
        "WAIT_TIMEOUT",
        // A settle still under way means every reading was ready, just not for long enough.
        settling !== undefined
          ? `${who ?? "the device"} had booted, but its services had not answered for ${formatDuration(SETTLE_MS)} in a row after ${after}`
          : `${who ?? "the device"} had not finished booting after ${after}`,
        {
          fields: {
            last: latest ?? { state: "unknown", ...UNREAD },
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
  switch (error.code) {
    case "DEVICE_NOT_FOUND": {
      const devices = error.fields.devices;
      if (error.message === "no attached device is online" && Array.isArray(devices)) {
        const state = devices.every((device: { state: string }) => device.state === "offline")
          ? "offline"
          : "not online";
        return { state, ...UNREAD };
      }
      return { state: "not attached", ...UNREAD };
    }
    case "DEVICE_OFFLINE": {
      const state = error.fields.state;
      return { state: typeof state === "string" ? state : "offline", ...UNREAD };
    }
    case "TIMEOUT":
      return { state: serial === undefined ? "unknown" : "device", ...UNREAD };
    default:
      return undefined;
  }
}

function flag01(value: boolean | null): number | typeof UNKNOWN {
  return value === null ? UNKNOWN : value ? 1 : 0;
}

function formatDuration(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`;
}
