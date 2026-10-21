import { defineGroup } from "../define.js";
import { doctorReport } from "./report.js";
import { doctorUi } from "./ui.js";

export const doctor = defineGroup({
  name: "doctor",
  summary: doctorReport.summary,
  defaultCommand: doctorReport,
  subcommands: [doctorUi],
});
