import { defineCommand } from "../define.js";

export const waitBoot = defineCommand({
  path: ["wait", "boot"],
  summary: "Wait until the device is online and has finished booting",
  defaultTimeoutMs: 120_000,
  examples: ["adb-axi wait boot", "adb-axi wait boot --device emulator-5556 --timeout 120s"],
});
