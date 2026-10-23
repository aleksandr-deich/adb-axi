import { assertPackageName } from "../../android/component.js";
import { formatDuration } from "../../core/duration.js";
import { AdbAxiError } from "../../core/errors.js";
import { okLine, runHint } from "../../core/output.js";
import { observe } from "../../core/poll.js";
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
    const adb = context.device.adb;
    const record = await context.device.app(pkg);
    const { userId } = record;
    // A package installed during the wait is not waited for.
    if (!record.installed) {
      if (wanted !== "stopped") throw notInstalled(context, pkg);
      return {
        ok: okLine("wait app", pkg, "stopped after 0 ms"),
        waited_ms: 0,
        note: `${pkg} is not installed for Android user ${userId}`,
      };
    }
    const app = record.identity;

    const result = await observe({
      deadline: context.deadline,
      read: (deadline) =>
        observeApp(adb, serial, app, userId, wanted === "foreground", {
          ...context.device.reads,
          deadline,
        }),
      done: (latest) => reached(wanted, latest),
    });

    if (!result.ok) {
      throw new AdbAxiError(
        "WAIT_TIMEOUT",
        `${pkg} did not reach ${wanted} within ${formatDuration(context.timeoutMs)}`,
        {
          fields: { last: result.last ?? { state: "unknown" } },
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
