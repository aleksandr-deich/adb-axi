import { defineCommand } from "../define.js";

export const waitApp = defineCommand({
  path: ["wait", "app"],
  summary: "Wait until an app reaches a state",
  positionals: [
    { name: "pkg", description: "Package name, for example com.example.notes", required: true },
  ],
  flags: [
    {
      name: "--state",
      type: "enum",
      values: ["foreground", "running", "stopped"],
      description: "The state to wait for",
      required: true,
    },
  ],
  examples: [
    "adb-axi wait app com.example.notes --state foreground",
    "adb-axi wait app com.example.notes --state stopped --timeout 10s",
  ],
});
