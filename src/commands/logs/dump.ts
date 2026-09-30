import { defineCommand } from "../define.js";

export const logsDump = defineCommand({
  path: ["logs"],
  summary: "A bounded log dump for one window, with level counts and repeats collapsed",
  flags: [
    {
      name: "--since",
      type: "string",
      valueName: "<mark|dur>",
      description: "Window start: a log mark name, or a duration back from now such as 30s",
    },
    {
      name: "--pkg",
      type: "string",
      valueName: "<pkg>",
      description: "Only this app",
    },
    {
      name: "--level",
      type: "enum",
      values: ["V", "D", "I", "W", "E"],
      description: "Minimum level to show",
    },
    {
      name: "--grep",
      type: "string",
      valueName: "<re>",
      description: "Only lines whose message matches this regex",
    },
    { name: "--full", type: "boolean", description: "Write the complete output to a file" },
  ],
  examples: [
    "adb-axi logs --pkg com.example.notes --since before-save --level W",
    "adb-axi logs --since 1m --grep Room",
  ],
});
