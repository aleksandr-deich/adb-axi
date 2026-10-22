import { identityOf } from "../../android/app-processes.js";
import { assertPackageName } from "../../android/component.js";
import { readPackageSnapshot } from "../../android/packages.js";
import { Deadline } from "../../core/deadline.js";
import { AdbAxiError } from "../../core/errors.js";
import { okLine, runHint } from "../../core/output.js";
import { MAX_INTERVAL_MS, poll } from "../../core/poll.js";
import { notInstalled } from "../app/process.js";
import { observeApp, type AppObservation, type AppState } from "../app/state.js";
import { defineCommand } from "../define.js";

export const waitApp = defineCommand({
  path: ["wait", "app"],
  summary: "Wait until an app reaches a state",
  positionals: [
    { name: "pkg", description: "Package name, for example com.example.notes", required: true },
  ],
  flags: [
    {
      name: "--state",
      type: "enum",
      values: ["foreground", "running", "stopped"],
      description: "The state to wait for",
      required: true,
    },
  ],
  examples: [
    "adb-axi wait app com.example.notes --state foreground",
    "adb-axi wait app com.example.notes --state stopped --timeout 10s",
  ],
  shipped: true,
  run: async (context) => {
    const pkg = String(context.positionals.pkg);
    const wanted = String(context.flags.state) as AppState;
    assertPackageName(pkg);
    const serial = context.device.serial;
    const options = context.device.reads;
    const adb = context.device.adb;
    const userId = await context.device.user();
    const { info, dump } = await readPackageSnapshot(adb, serial, pkg, options, userId);
    // Read once: a package installed during the wait is not waited for.
    if (info === null || !info.installed) {
      if (wanted !== "stopped") throw notInstalled(context, pkg);
      return {
        ok: okLine("wait app", pkg, "stopped after 0 ms"),
        waited_ms: 0,
        note: `${pkg} is not installed for Android user ${userId}`,
      };
    }
    const app = identityOf(info, dump);

    let latest: AppObservation | undefined;
    const result = await poll({
      timeoutMs: context.deadline.remainingMs(),
      check: async (remainingMs) => {
        const reads =
          remainingMs < MAX_INTERVAL_MS ? { deadline: new Deadline(MAX_INTERVAL_MS) } : options;
        try {
          latest = await observeApp(adb, serial, app, userId, wanted === "foreground", reads);
        } catch (error) {
          // A read cut off by the deadline ends the wait; the last full observation is the evidence.
          if (error instanceof AdbAxiError && error.code === "TIMEOUT") {
            return { done: false, last: latest };
          }
          throw error;
        }
        return reached(wanted, latest)
          ? { done: true, value: latest }
          : { done: false, last: latest };
      },
    });

    if (!result.ok) {
      throw new AdbAxiError(
        "WAIT_TIMEOUT",
        `${pkg} did not reach ${wanted} within ${formatDuration(context.timeoutMs)}`,
        {
          fields: { last: latest ?? { state: "unknown" } },
          help: [
            runHint(["app", "info", pkg], "for its pid and foreground state"),
            runHint(["app", "current"], "to see what is in front"),
          ],
        },
      );
    }
    return {
      ok: okLine("wait app", pkg, `${wanted} after ${result.waitedMs} ms`),
      waited_ms: result.waitedMs,
    };
  },
});

/** Whether an observation satisfies the wanted state. Foreground implies running. */
function reached(wanted: AppState, observation: AppObservation): boolean {
  if (wanted === "running") return observation.state !== "stopped";
  return observation.state === wanted;
}

function formatDuration(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`;
}
