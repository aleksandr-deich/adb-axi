import { identityOf, mainProcess, runningProcesses } from "../../android/app-processes.js";
import { readForeground } from "../../android/foreground.js";
import { readPackageSnapshot } from "../../android/packages.js";
import { defineCommand } from "../define.js";
import { UNKNOWN } from "./shared.js";

export const appCurrent = defineCommand({
  path: ["app", "current"],
  summary: "The app in the foreground now: package, activity and pid",
  examples: ["adb-axi app current", "adb-axi app current --device Pixel_Tablet"],
  shipped: true,
  run: async (context) => {
    const serial = context.device.serial;
    const options = context.device.reads;
    const adb = context.device.adb;
    const userId = await context.device.user();

    // A launcher in front is an answer like any other app.
    const resumed = await readForeground(adb, serial, { ...options, userId });
    if (resumed === null) {
      return {
        app: { package: UNKNOWN, activity: UNKNOWN, pid: UNKNOWN },
        note: "no activity is resumed, the screen may be off",
      };
    }
    const { info, dump } = await readPackageSnapshot(adb, serial, resumed.package, options, userId);
    const app = info === null ? null : identityOf(info, dump);
    const main =
      app === null
        ? undefined
        : mainProcess(app, await runningProcesses(adb, serial, app, options));
    return {
      app: { package: resumed.package, activity: resumed.activity, pid: main?.pid ?? UNKNOWN },
    };
  },
});
