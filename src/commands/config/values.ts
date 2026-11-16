import { AdbAxiError } from "../../core/errors.js";

export const KEYS = ["animations", "night", "font_scale", "density", "size"] as const;
export type ConfigKey = (typeof KEYS)[number];
export const ANIMATION_ALIASES = ["window", "transition", "animator"] as const;
export const NIGHT: Record<string, string> = { "0": "auto", "1": "no", "2": "yes" };
export function configKey(raw: string): ConfigKey {
  if (!(KEYS as readonly string[]).includes(raw)) {
    throw new AdbAxiError("VALIDATION_ERROR", `Unknown config key ${raw}; use ${KEYS.join(", ")}`);
  }
  return raw as ConfigKey;
}
export function isScale(value: string, positive: boolean): boolean {
  return (
    /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) &&
    Number.isFinite(Number(value)) &&
    Number.isFinite(Math.fround(Number(value))) &&
    (positive ? Math.fround(Number(value)) > 0 : Number(value) >= 0)
  );
}
export function configValues(key: ConfigKey, value: string): string[] {
  if (key === "animations" && value.includes("=")) {
    const parts = value.split(",");
    const pairs = parts.map((part) => part.split("="));
    if (
      parts.length !== 3 ||
      pairs.some((pair) => pair.length !== 2) ||
      new Set(pairs.map(([alias]) => alias)).size !== 3 ||
      pairs.some(([alias]) => !ANIMATION_ALIASES.some((known) => known === alias))
    ) {
      throw new AdbAxiError(
        "VALIDATION_ERROR",
        "Use window=<scale|unset>,transition=<scale|unset>,animator=<scale|unset>",
      );
    }
    return ANIMATION_ALIASES.map((alias) => {
      const raw = pairs.find(([name]) => name === alias)?.[1] ?? "";
      validate(key, raw);
      return raw;
    });
  }
  validate(key, value);
  return key === "animations" ? ANIMATION_ALIASES.map(() => value) : [value];
}
function validate(key: ConfigKey, value: string): void {
  if (value === "unset") return;
  let valid: boolean;
  switch (key) {
    case "animations":
      valid = isScale(value, false);
      break;
    case "font_scale":
      valid = isScale(value, true);
      break;
    case "night":
      valid = ["yes", "no", "auto"].includes(value);
      break;
    case "density":
      valid =
        value === "reset" ||
        (/^\d+$/.test(value) && Number(value) >= 72 && Number(value) <= 2147483647);
      break;
    case "size":
      valid =
        value === "reset" ||
        (/^\d+(?:dp)?x\d+(?:dp)?$/.test(value) &&
          value
            .split("x")
            .every(
              (part) => Number.parseInt(part, 10) > 0 && Number.parseInt(part, 10) <= 2147483647,
            ));
      break;
  }
  if (!valid)
    throw new AdbAxiError("VALIDATION_ERROR", `Invalid ${key} value ${JSON.stringify(value)}`, {
      help: [
        "Use animations: non-negative scale or window=..,transition=..,animator=..; night: yes/no/auto; font_scale: positive scale; density: integer >=72 or reset; size: WxH (optional dp suffixes) or reset; unset deletes rows",
      ],
    });
}
