import { defineCommand } from "../define.js";

export const logsCrash = defineCommand({
  path: ["logs", "crash"],
  summary: "Java crashes, ANRs and native crashes in one window, matched by package name",
  flags: [
    {
      name: "--pkg",
      type: "string",
      valueName: "<pkg>",
      description: "Only this app",
    },
    {
      name: "--since",
      type: "string",
      valueName: "<mark|dur>",
      description: "Window start: a log mark name, or a duration back from now such as 30s",
    },
    { name: "--full", type: "boolean", description: "Write the whole trace to a file" },
  ],
  examples: [
    "adb-axi logs crash --pkg com.example.notes --since before-save",
    "adb-axi logs crash --since 5m",
  ],
});
