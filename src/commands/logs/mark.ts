import { okLine } from "../../core/output.js";
import { defineCommand } from "../define.js";
import { assertMarkName } from "./marks.js";
import { recordLogMark } from "./window.js";

export const logsMark = defineCommand({
  path: ["logs", "mark"],
  help: [
    "Marks belong to one device boot; a different boot ID, including a reused emulator serial, drops previous marks",
  ],
  summary: "Record the device clock under a name, to scope later logs and crash reads",
  positionals: [
    {
      name: "name",
      description:
        "Mark name; defaults to mark-<HHMMSS> from device time. Take marks one at a time per device: simultaneous logs mark calls can lose one",
      required: false,
    },
  ],
  examples: ["adb-axi logs mark before-save", "adb-axi logs mark"],
  shipped: true,
  run: async (context) => {
    const given = context.positionals.name;
    if (given !== undefined) assertMarkName(String(given));
    const { name, shown, marksNote } = await recordLogMark(
      context.device,
      given === undefined ? undefined : String(given),
      context.env,
    );
    return {
      ok: okLine("mark", name, `${shown} on ${context.device.serial}`),
      ...(marksNote === undefined ? {} : { marks_note: marksNote }),
    };
  },
});
