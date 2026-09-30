import { defineCommand } from "../define.js";

export const appKill = defineCommand({
  path: ["app", "kill"],
  summary: "Kill an app's process the way the system does, keeping its task in recents",
  positionals: [
    { name: "pkg", description: "Package name, for example com.example.notes", required: true },
  ],
  examples: [
    "adb-axi app kill com.example.notes",
    "adb-axi app kill com.example.notes --timeout 20s",
  ],
});
