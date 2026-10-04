import { formatDeviceTime, readDeviceClock } from "../../android/clock.js";
import { invalidOutput } from "../../android/read.js";
import { readProcessNames } from "../../android/ps.js";
import { okLine } from "../../core/output.js";
import { readShellFacts } from "../../device/facts.js";
import { readOptions, targetSerial } from "../app/shared.js";
import { defineCommand } from "../define.js";
import { appProcesses, assertMarkName, writeMark } from "./marks.js";
import { PID_LIST_BELOW_API } from "./scope.js";

export const logsMark = defineCommand({
  path: ["logs", "mark"],
  summary: "Record the device clock under a name, to scope later logs and crash reads",
  positionals: [
    {
      name: "name",
      description:
        "Mark name; defaults to mark-<HHMMSS> from device time. Take marks one at a time per device: simultaneous logs mark calls can lose one",
      required: false,
    },
  ],
  examples: ["adb-axi logs mark before-save", "adb-axi logs mark"],
  shipped: true,
  run: async (context) => {
    const given = context.positionals.name;
    if (given !== undefined) assertMarkName(String(given));
    const serial = targetSerial(context);
    const options = readOptions(context);
    const adb = context.adb();
    const device = context.target?.device;
    if (device === undefined) throw new TypeError("logs mark ran without a resolved device");

    // On API 29 and 30 `logs --pkg` is a pid list, so the mark keeps the app processes
    // that are running now. They are read before the clock, so the window starts after them.
    const facts = await readShellFacts(adb, device, {
      deadline: context.deadline,
      env: context.env,
    });
    if (facts.api === null) throw invalidOutput("reading the Android version", "");
    const processes =
      facts.api < PID_LIST_BELOW_API
        ? appProcesses(await readProcessNames(adb, serial, options))
        : [];

    const now = await readDeviceClock(adb, serial, options);
    const shown = formatDeviceTime(now.epochMs, now.utcOffsetMinutes);
    const name =
      given === undefined ? `mark-${shown.slice(11, 19).replaceAll(":", "")}` : String(given);
    writeMark(serial, context.env, name, {
      epochMs: now.epochMs,
      utcOffsetMinutes: now.utcOffsetMinutes,
      processes,
      hostEpochMs: Date.now(),
    });
    return { ok: okLine("mark", name, `${shown} on ${serial}`) };
  },
});
