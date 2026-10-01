import { readForeground } from "../../android/foreground.js";
import { pidof } from "../../android/pidof.js";
import { defineCommand } from "../define.js";
import { readOptions, targetSerial, UNKNOWN } from "./shared.js";

export const appCurrent = defineCommand({
  path: ["app", "current"],
  summary: "The app in the foreground now: package, activity and pid",
  examples: ["adb-axi app current", "adb-axi app current --device Pixel_Tablet"],
  shipped: true,
  run: async (context) => {
    const serial = targetSerial(context);
    const options = readOptions(context);
    const adb = context.adb();

    // A launcher in front is an answer like any other app.
    const resumed = await readForeground(adb, serial, options);
    if (resumed === null) {
      return {
        app: { package: UNKNOWN, activity: UNKNOWN, pid: UNKNOWN },
        note: "no activity is resumed, the screen may be off",
      };
    }
    const pids = await pidof(adb, serial, resumed.package, options);
    return {
      app: { package: resumed.package, activity: resumed.activity, pid: pids[0] ?? UNKNOWN },
    };
  },
});
