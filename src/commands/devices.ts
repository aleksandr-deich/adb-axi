import { defineCommand } from "./define.js";

export const devices = defineCommand({
  path: ["devices"],
  summary: "Every attached device with its AVD name, state, API level and form",
  device: "none",
  flags: [
    {
      name: "--all",
      type: "boolean",
      description: "Include devices in unusual states such as recovery or sideload",
    },
    {
      name: "--fields",
      type: "string",
      valueName: "<list>",
      description: "Extra comma-separated columns: boot, data_free, model, abi, uptime",
    },
  ],
  examples: ["adb-axi devices", "adb-axi devices --fields model,abi"],
});
