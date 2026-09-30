import { defineCommand } from "../define.js";

export const appCurrent = defineCommand({
  path: ["app", "current"],
  summary: "The app in the foreground now: package, activity and pid",
  examples: ["adb-axi app current", "adb-axi app current --device Pixel_Tablet"],
});
