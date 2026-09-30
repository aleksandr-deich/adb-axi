import { defineCommand } from "../define.js";

export const appList = defineCommand({
  path: ["app", "list"],
  summary: "Installed user packages with a count, optionally including system packages",
  flags: [
    { name: "--all", type: "boolean", description: "Include system packages" },
    {
      name: "--grep",
      type: "string",
      valueName: "<re>",
      description: "Only packages whose name matches this regex",
    },
  ],
  examples: ["adb-axi app list", "adb-axi app list --grep example"],
});
