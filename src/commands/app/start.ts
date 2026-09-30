import { defineCommand } from "../define.js";

export const appStart = defineCommand({
  path: ["app", "start"],
  summary: "Start an app, then report what is in the foreground and how it launched",
  positionals: [
    {
      name: "pkg",
      description: "Package name, optionally with /<activity>",
      required: true,
    },
  ],
  flags: [
    { name: "--fresh", type: "boolean", description: "Force-stop first so the start is cold" },
    {
      name: "--activity",
      type: "string",
      valueName: "<name>",
      description: "Activity to start instead of the launcher activity",
    },
  ],
  examples: ["adb-axi app start com.example.notes", "adb-axi app start com.example.notes --fresh"],
});
