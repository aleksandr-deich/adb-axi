import { defineCommand } from "../define.js";

export const appDeath = defineCommand({
  path: ["app", "death"],
  summary: "Kill and restore an app in one call, with before and after evidence",
  positionals: [
    { name: "pkg", description: "Package name, for example com.example.notes", required: true },
  ],
  flags: [
    {
      name: "--compare",
      type: "boolean",
      description: "Also diff the visible text before and after, through agent-device",
    },
  ],
  defaultTimeoutMs: 30_000,
  examples: [
    "adb-axi app death com.example.notes",
    "adb-axi app death com.example.notes --compare",
  ],
});
