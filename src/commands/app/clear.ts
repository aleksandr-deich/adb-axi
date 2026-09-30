import { defineCommand } from "../define.js";

export const appClear = defineCommand({
  path: ["app", "clear"],
  summary: "Clear an app's data, verify it is cleared, and report the process stopped",
  positionals: [
    { name: "pkg", description: "Package name, for example com.example.notes", required: true },
  ],
  examples: ["adb-axi app clear com.example.notes"],
});
