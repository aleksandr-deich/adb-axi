import { AdbAxiError } from "../core/errors.js";
import { runHint } from "../core/output.js";
import { defineCommand } from "./define.js";

/** The no-argument home view (8.1): live device state, not a manual. */
export const home = defineCommand({
  path: [],
  summary: "Devices, the resolved target, its foreground app and recent crashes",
  examples: ["adb-axi", "adb-axi --json"],
  device: "none",
  run: () =>
    Promise.reject(
      new AdbAxiError("NOT_IMPLEMENTED", "The home view is not available in this build", {
        help: [runHint(["--help"], "to see the commands this build ships")],
      }),
    ),
});
