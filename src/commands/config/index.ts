import { AdbAxiError } from "../../core/errors.js";
import { defineCommand, defineGroup } from "../define.js";
import { snapshot, verify, writeConfig } from "./state.js";
import { KEYS, configKey, configValues } from "./values.js";

const help = [
  "Keys: animations, night, font_scale, density, size. Per-user rows use the resolved current Android user, printed as user",
  'Each row includes present and raw text: absent is present:false,text:null; the literal string null is present:true,text:"null"',
  "before.value is a pasteable restore value; null means an unsupported raw state, which set refuses to change",
  "animations accepts a non-negative scale for all rows or window=<scale|unset>,transition=<scale|unset>,animator=<scale|unset>",
  "night: yes/no/auto; font_scale: positive scale; density: integer >=72; size: WxH with optional dp suffix on either dimension",
  "Night writes require resolved user 0: the platform command applies night mode to user 0 only; other users are refused before any write",
  "unset deletes rows; density/size reset leaves present-empty rows. Neither is a saved baseline or reset command",
  "Set writes then reads back; CONFIG_MISMATCH is failure, with before/after evidence. Restore before.value in the same turn; no automatic rollback",
];
const get = defineCommand({
  path: ["config", "get"],
  summary: "Read raw device settings rows and their effective values",
  positionals: [{ name: "key", description: "Config key; omit to read all five", required: false }],
  help,
  examples: ["adb-axi config get --device emulator-5554", "adb-axi config get animations --json"],
  shipped: true,
  run: async (context) => {
    const keys =
      typeof context.positionals.key === "string" ? [configKey(context.positionals.key)] : KEYS;
    const user = await context.device.user();
    const config = [];
    for (const key of keys) config.push({ key, ...(await snapshot(context, key, user)) });
    return { user, config };
  },
});
const set = defineCommand({
  path: ["config", "set"],
  summary: "Validate, write and verify device settings, with an exact restore value",
  positionals: [
    { name: "key", description: "animations, night, font_scale, density or size", required: true },
    {
      name: "value",
      description: "Validated key value or unset (density/size also accept reset)",
      required: true,
    },
  ],
  help,
  examples: [
    "adb-axi config set animations 0 --device emulator-5554",
    "adb-axi config set animations window=unset,transition=1,animator=0.5",
    "adb-axi config set density unset",
  ],
  shipped: true,
  run: async (context) => {
    const key = configKey(String(context.positionals.key));
    const values = configValues(key, String(context.positionals.value));
    const user = await context.device.user();
    if (key === "night" && user !== 0)
      throw new AdbAxiError(
        "VALIDATION_ERROR",
        "The platform applies night mode to user 0 only; config set night refuses other resolved users before any write",
        { fields: { key, user } },
      );
    const before = await snapshot(context, key, user);
    if (before.value === null)
      throw new AdbAxiError(
        "INVALID_OUTPUT",
        "Original raw config cannot be restored with this command; no write attempted",
        { fields: { key, user, before } },
      );
    try {
      await writeConfig(context, key, values, user);
      const after = await snapshot(context, key, user);
      await verify(context, key, values, before, after, user);
      return { key, user, before, after };
    } catch (error) {
      if (error instanceof AdbAxiError && error.fields.before === undefined) {
        throw new AdbAxiError(error.code, error.message, {
          fields: { key, user, before, ...error.fields },
          help: [
            ...error.help,
            "A write may have partially applied; restore using before.value on this device",
          ],
          cause: error,
        });
      }
      throw error;
    }
  },
});
export const config = defineGroup({
  name: "config",
  summary: "Read and temporarily change a small set of device settings",
  subcommands: [get, set],
});
