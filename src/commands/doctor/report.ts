import { defineCommand } from "../define.js";

export const doctorReport = defineCommand({
  path: ["doctor"],
  summary: "Check the host, the adb server and the target for things that break a run",
  examples: ["adb-axi doctor", "adb-axi doctor --device emulator-5554"],
});
