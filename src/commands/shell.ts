import { defineCommand } from "./define.js";

export const shell = defineCommand({
  path: ["shell"],
  summary: "Run one command string in the device shell and report its real exit code",
  positionals: [
    {
      name: "cmd",
      description: "The command string, passed after `--` to the device's sh",
      required: true,
      rest: true,
    },
  ],
  flags: [{ name: "--full", type: "boolean", description: "Write the complete output to a file" }],
  examples: [
    "adb-axi shell -- 'getprop ro.build.version.sdk'",
    "adb-axi shell --device emulator-5556 -- 'ls /data/local/tmp'",
  ],
});
