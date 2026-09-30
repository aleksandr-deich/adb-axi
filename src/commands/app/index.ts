import { defineGroup } from "../define.js";
import { appClear } from "./clear.js";
import { appCurrent } from "./current.js";
import { appDeath } from "./death.js";
import { appInfo } from "./info.js";
import { appInstall } from "./install.js";
import { appKill } from "./kill.js";
import { appList } from "./list.js";
import { appRestore } from "./restore.js";
import { appStart } from "./start.js";
import { appStop } from "./stop.js";
import { appUninstall } from "./uninstall.js";

export const app = defineGroup({
  name: "app",
  summary: "App lifecycle: inspect, install, start, stop, kill and restore apps",
  subcommands: [
    appCurrent,
    appList,
    appInfo,
    appInstall,
    appUninstall,
    appStart,
    appStop,
    appClear,
    appKill,
    appRestore,
    appDeath,
  ],
});
