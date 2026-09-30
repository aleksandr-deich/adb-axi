import { defineCommand } from "../define.js";

export const logsMark = defineCommand({
  path: ["logs", "mark"],
  summary: "Record the device clock under a name, to scope later logs and crash reads",
  positionals: [
    {
      name: "name",
      description: "Mark name; defaults to mark-<HHMMSS> from device time",
      required: false,
    },
  ],
  examples: ["adb-axi logs mark before-save", "adb-axi logs mark"],
});
