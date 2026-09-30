import { defineCommand } from "../define.js";

export const appUninstall = defineCommand({
  path: ["app", "uninstall"],
  summary: "Remove a package; a package that is not installed is a no-op",
  positionals: [
    { name: "pkg", description: "Package name, for example com.example.notes", required: true },
  ],
  flags: [{ name: "--keep-data", type: "boolean", description: "Keep the app's data directory" }],
  examples: [
    "adb-axi app uninstall com.example.notes",
    "adb-axi app uninstall com.example.notes --keep-data",
  ],
});
