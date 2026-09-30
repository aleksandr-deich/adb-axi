import { defineCommand } from "../define.js";

export const appStop = defineCommand({
  path: ["app", "stop"],
  summary: "Force-stop an app and verify its process is gone",
  positionals: [
    { name: "pkg", description: "Package name, for example com.example.notes", required: true },
  ],
  examples: ["adb-axi app stop com.example.notes"],
});
