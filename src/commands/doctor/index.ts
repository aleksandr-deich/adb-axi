import { defineGroup } from "../define.js";
import { doctorReport } from "./report.js";
import { doctorUi } from "./ui.js";

export const doctor = defineGroup({
  name: "doctor",
  summary: "Health checks for the host, the adb server and the target device",
  defaultCommand: doctorReport,
  subcommands: [doctorUi],
});
