import { defineCommand } from "../define.js";

export const appInfo = defineCommand({
  path: ["app", "info"],
  summary: "One package's facts: installed, version, debuggable, pid, foreground, data size",
  positionals: [
    { name: "pkg", description: "Package name, for example com.example.notes", required: true },
  ],
  examples: ["adb-axi app info com.example.notes"],
});
