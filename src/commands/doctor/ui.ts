import { defineCommand } from "../define.js";

export const doctorUi = defineCommand({
  path: ["doctor", "ui"],
  summary: "Find on-device UiAutomation holders and classify them as live, leaked or wedged",
  flags: [
    {
      name: "--fix",
      type: "boolean",
      description: "Clear leaked and wedged holders; live ones are never touched",
    },
  ],
  examples: ["adb-axi doctor ui", "adb-axi doctor ui --fix"],
});
