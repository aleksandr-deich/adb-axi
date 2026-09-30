import { defineCommand } from "../define.js";

export const waitLog = defineCommand({
  path: ["wait", "log"],
  summary: "Wait until a log line after the window start matches a regex",
  positionals: [
    { name: "regex", description: "Regex matched against log messages", required: true },
  ],
  flags: [
    {
      name: "--since",
      type: "string",
      valueName: "<mark|dur>",
      description: "Window start: a log mark name, or a duration back from now such as 30s",
    },
  ],
  examples: ["adb-axi wait log 'Displayed com.example.notes' --since before-start"],
});
