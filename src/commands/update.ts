import { runUpdate } from "axi-sdk-js";
import { VERSION } from "../version.js";
import { defineCommand } from "./define.js";

/**
 * Self-update from npm. The SDK owns the logic; adb-axi registers it as its own command
 * so flags are validated like every other command, `--json` works, and progress goes to
 * stderr.
 */
export const update = defineCommand({
  path: ["update"],
  summary: "Upgrade adb-axi to the latest published version",
  device: "none",
  shipped: true,
  flags: [
    {
      name: "--check",
      type: "boolean",
      description: "Report the current and latest versions without installing",
    },
    { name: "--dry-run", type: "boolean", description: "Same as --check" },
  ],
  examples: ["adb-axi update --check", "adb-axi update"],
  run: async (context) => {
    const check = context.flags.check === true || context.flags["dry-run"] === true;
    const output = await runUpdate({
      args: check ? ["--check"] : [],
      stdout: process.stderr,
      version: VERSION,
    });
    return typeof output === "string" ? { update: output } : output;
  },
});
