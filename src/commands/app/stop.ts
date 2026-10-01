import { assertPackageName } from "../../android/component.js";
import { pidof } from "../../android/pidof.js";
import { noop, okLine } from "../../core/output.js";
import { realClock } from "../../core/poll.js";
import { defineCommand } from "../define.js";
import { forceStop, pidLabel, requireInstalled, stopFailed, waitForExit } from "./process.js";
import { readOptions, targetSerial } from "./shared.js";

export const appStop = defineCommand({
  path: ["app", "stop"],
  summary: "Force-stop an app and verify its process is gone",
  positionals: [
    { name: "pkg", description: "Package name, for example com.example.notes", required: true },
  ],
  examples: ["adb-axi app stop com.example.notes"],
  shipped: true,
  run: async (context) => {
    const pkg = String(context.positionals.pkg);
    assertPackageName(pkg);
    const serial = targetSerial(context);
    const adb = context.adb();

    await requireInstalled(context, pkg);
    const before = await pidof(adb, serial, pkg, readOptions(context));
    const started = realClock.now();
    await forceStop(adb, serial, pkg, readOptions(context));
    if (before.length === 0) {
      return { ok: okLine("stop", pkg, noop("already not running")) };
    }

    const exit = await waitForExit(adb, serial, pkg, context);
    if (!exit.gone) {
      throw stopFailed(pkg, exit.last, context.timeoutMs, {
        command: ["app", "stop", pkg],
        step: "am force-stop",
      });
    }
    const tookMs = Math.round(realClock.now() - started);
    return {
      ok: okLine("stop", pkg, `not running (${pidLabel(before)} gone after ${tookMs} ms)`),
    };
  },
});
