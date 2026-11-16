import { invalidOutput, readShell } from "../../android/read.js";
import { AdbAxiError } from "../../core/errors.js";
import { shellWords } from "../../core/output.js";
import { observe } from "../../core/poll.js";
import type { DeviceContext } from "../types.js";
import { ANIMATION_ALIASES, NIGHT, configValues, isScale, type ConfigKey } from "./values.js";

type Namespace = "global" | "secure" | "system";
interface RowSpec {
  name: string;
  namespace: Namespace;
  alias: string;
}
export interface Row extends RowSpec {
  present: boolean;
  text: string | null;
}
export interface Snapshot {
  rows: Row[];
  effective: string | Record<string, number | null>;
  effective_note?: string;
  value: string | null;
}
const ROWS: Record<ConfigKey, RowSpec[]> = {
  animations: ANIMATION_ALIASES.map((alias) => ({
    name: alias === "animator" ? "animator_duration_scale" : `${alias}_animation_scale`,
    namespace: "global",
    alias,
  })),
  night: [{ name: "ui_night_mode", namespace: "secure", alias: "night" }],
  font_scale: [{ name: "font_scale", namespace: "system", alias: "font_scale" }],
  density: [{ name: "display_density_forced", namespace: "secure", alias: "density" }],
  size: [{ name: "display_size_forced", namespace: "global", alias: "size" }],
};
// UiModeManagerService.persistNightMode and persistNightModeOverrides write these alongside ui_night_mode.
const NIGHT_COMPANIONS: RowSpec[] = [
  "dark_theme_custom_start_time",
  "dark_theme_custom_end_time",
  "ui_night_mode_custom_type",
  "ui_night_mode_override_on",
  "ui_night_mode_override_off",
].map((name) => ({ name, namespace: "secure", alias: name }));

async function shell(context: DeviceContext, command: string): Promise<string> {
  const result = await readShell(
    context.device.adb,
    context.device.serial,
    command,
    "reading or changing device configuration",
    context.device.reads,
  );
  return result.stdout;
}
function selector(row: RowSpec, user: number): string {
  return row.namespace === "global" ? "" : `--user ${user} `;
}
async function readRows(context: DeviceContext, specs: RowSpec[], user: number): Promise<Row[]> {
  const outputs = new Map<Namespace, string>();
  const rows: Row[] = [];
  for (const spec of specs) {
    let output = outputs.get(spec.namespace);
    if (output === undefined) {
      output = await shell(context, `settings ${selector(spec, user)}list ${spec.namespace}`);
      outputs.set(spec.namespace, output);
    }
    const matches = output.split(/\r?\n/).filter((line) => line.startsWith(`${spec.name}=`));
    if (matches.length > 1) throw invalidOutput("reading config rows", output);
    rows.push({
      ...spec,
      present: matches.length === 1,
      text: matches[0]?.slice(spec.name.length + 1) ?? null,
    });
  }
  return rows;
}
async function nightMode(context: DeviceContext): Promise<string> {
  const output = await shell(context, "cmd uimode night");
  const value = /^Night mode: (yes|no|auto|custom(?:_schedule|_bedtime)?)\s*$/.exec(output)?.[1];
  if (value === undefined) throw invalidOutput("reading night mode", output);
  return value;
}
async function fontScale(context: DeviceContext): Promise<string> {
  const output = await shell(context, "dumpsys activity | grep 'mGlobalConfiguration:'");
  const value = /mGlobalConfiguration:\s*\{([0-9.eE+-]+)\s/.exec(output)?.[1];
  if (value === undefined || !isScale(value, true))
    throw invalidOutput("reading effective font scale", output);
  return value;
}
async function display(
  context: DeviceContext,
  key: "density" | "size",
): Promise<{ physical: string; effective: string }> {
  const output = await shell(context, `wm ${key}`);
  const pattern =
    key === "density"
      ? /^(Physical|Override) density: (\d+)$/gm
      : /^(Physical|Override) size: (\d+x\d+)$/gm;
  const values = [...output.matchAll(pattern)];
  const physical = values.find((item) => item[1] === "Physical")?.[2];
  if (physical === undefined) throw invalidOutput(`reading display ${key}`, output);
  return { physical, effective: values.find((item) => item[1] === "Override")?.[2] ?? physical };
}
export async function snapshot(
  context: DeviceContext,
  key: ConfigKey,
  user: number,
): Promise<Snapshot> {
  const rows = await readRows(context, ROWS[key], user);
  let effective: Snapshot["effective"];
  const displayState = key === "density" || key === "size" ? await display(context, key) : null;
  if (key === "animations") {
    effective = Object.fromEntries(
      rows.map((item) => [
        item.alias,
        !item.present
          ? 1
          : item.text !== null && isScale(item.text, false) && Number(item.text) <= 20
            ? Math.fround(Number(item.text))
            : null,
      ]),
    );
  } else if (key === "font_scale") effective = await fontScale(context);
  else if (key === "night") effective = await nightMode(context);
  else if (displayState !== null) effective = displayState.effective;
  else throw invalidOutput("reading display configuration", key);
  const tokens = rows.map((item): string | null => {
    if (!item.present) return key === "night" && effective !== "no" ? null : "unset";
    const text = item.text;
    if (text === null || text === "unset" || text === "reset") return null;
    if (key === "font_scale" && text !== effective) return null;
    if (key === "night") return NIGHT[text] ?? null;
    if ((key === "density" || key === "size") && text === "") return "reset";
    const token = key === "size" ? text.replace(",", "x") : text;
    // wm normalizes its arguments; refuse raw overrides it cannot reproduce exactly.
    if (key === "density" && String(Number(text)) !== text) return null;
    if (
      key === "size" &&
      text
        .split(",")
        .map((part) => String(Number(part)))
        .join(",") !== text
    )
      return null;
    try {
      configValues(key, token);
      if (displayState !== null && token === displayState.physical) return null;
      if (displayState !== null && key === "size" && !sizeWithinBounds(token, displayState.physical))
        return null;
      return token;
    } catch {
      return null;
    }
  });
  return {
    rows,
    effective,
    ...(key === "animations"
      ? {
          effective_note:
            "Row-derived estimates, not verified live scales; absent rows assume default 1. Null means unknown, including scales above 20 whose clamping is platform-dependent (Android 15 clamps to 20; older releases may not). unset requests default 1 before deleting rows; live scales are normally 1 afterwards but are not verified",
        }
      : {}),
    value: tokens.some((token) => token === null)
      ? null
      : key === "animations"
        ? rows.map((item, index) => `${item.alias}=${tokens[index]}`).join(",")
        : (tokens[0] ?? null),
  };
}
async function putRow(
  context: DeviceContext,
  row: RowSpec,
  user: number,
  text: string | null,
): Promise<void> {
  const command =
    text === null
      ? `delete ${row.namespace} ${row.name}`
      : `put ${row.namespace} ${row.name} ${shellWords([text])}`;
  await shell(context, `settings ${selector(row, user)}${command}`);
}
async function preserveRows(
  context: DeviceContext,
  specs: RowSpec[],
  user: number,
  write: () => Promise<void>,
): Promise<void> {
  const companions = await readRows(context, specs, user);
  let writeError: Error | undefined;
  try {
    await write();
  } catch (error) {
    writeError =
      error instanceof Error
        ? error
        : new AdbAxiError("INTERNAL_ERROR", "Configuration write failed", {
            fields: { detail: String(error) },
          });
  }
  const changed = await readRows(context, specs, user);
  for (const [index, row] of companions.entries()) {
    if (changed[index]?.present !== row.present || changed[index].text !== row.text)
      await putRow(context, row, user, row.text);
  }
  const restored = await readRows(context, specs, user);
  if (
    restored.some(
      (row, index) =>
        row.present !== companions[index]?.present || row.text !== companions[index].text,
    )
  ) {
    throw new AdbAxiError(
      "CONFIG_MISMATCH",
      "Configuration companion rows could not be preserved",
      {
        fields: { companions_before: companions, companions_after: restored },
      },
    );
  }
  if (writeError !== undefined) throw writeError;
}
function sizeWithinBounds(value: string, physical: string): boolean {
  const limits = physical.split("x").map((dimension) => 2 * Number(dimension));
  return value
    .split("x")
    .every(
      (dimension, index) => Number(dimension) >= 200 && Number(dimension) <= (limits[index] ?? 0),
    );
}
export async function preflightConfig(
  context: DeviceContext,
  key: ConfigKey,
  values: string[],
  user: number,
): Promise<void> {
  if (key === "size" && !["unset", "reset"].includes(values[0] ?? "")) {
    const physical = (await display(context, "size")).physical;
    const dimensions = await pixelSize(context, values[0] ?? "");
    if (!sizeWithinBounds(dimensions, physical)) {
      throw new AdbAxiError(
        "VALIDATION_ERROR",
        `Size dimensions must resolve to at least 200 pixels and at most twice each physical dimension (${physical
          .split("x")
          .map((dimension) => 2 * Number(dimension))
          .join("x")}); no write attempted`,
      );
    }
  }
  // wm uses the foreground user implicitly; refuse a switch rather than target another user.
  const current = (await shell(context, "am get-current-user")).trim();
  if (current !== String(user))
    throw new AdbAxiError("VALIDATION_ERROR", "Android user changed; no write attempted", {
      fields: { user, current },
    });
}
async function pixelSize(context: DeviceContext, value: string): Promise<string> {
  const density = value.includes("dp")
    ? Number((await display(context, "density")).effective)
    : 160;
  return value
    .split("x")
    .map((part) => {
      const number = Number.parseInt(part, 10);
      if (part.endsWith("dp") && number * density > 2147483647)
        throw new AdbAxiError(
          "VALIDATION_ERROR",
          "Size dp conversion overflows the platform integer; no write attempted",
        );
      return part.endsWith("dp") ? Math.trunc((number * density) / 160) : number;
    })
    .join("x");
}
export async function writeConfig(
  context: DeviceContext,
  key: ConfigKey,
  values: string[],
  user: number,
): Promise<void> {
  const value = values[0] ?? "";
  if (key === "night")
    await preserveRows(context, NIGHT_COMPANIONS, user, async () => {
      const desired = value === "unset" ? "no" : value;
      await shell(context, `cmd uimode night ${desired}`);
      // A locked device can silently refuse the command; do not change its row on refusal.
      if ((await nightMode(context)) === desired) {
        const code = Object.entries(NIGHT).find(([, name]) => name === value)?.[0];
        if (value === "unset" || code !== undefined)
          await putRow(context, ROWS.night[0] as RowSpec, user, code ?? null);
      }
    });
  if (key === "density" || key === "size")
    await shell(context, `wm ${key} ${value === "unset" ? "reset" : value}`);
  if (key === "font_scale") {
    await preserveRows(
      context,
      [{ name: "system_locales", namespace: "system", alias: "locales" }],
      user,
      async () => {
        const desired = value === "unset" ? "1.0" : value;
        await putRow(context, ROWS.font_scale[0] as RowSpec, user, desired);
        let stable = 0;
        const settled = await observe({
          deadline: context.deadline,
          windowMs: 5000,
          read: async () => fontScale(context),
          done: (effective) => {
            stable =
              Math.fround(Number(effective)) === Math.fround(Number(desired)) ? stable + 1 : 0;
            return stable >= 2;
          },
        });
        if (!settled.ok)
          throw new AdbAxiError("CONFIG_MISMATCH", "Requested font scale did not take effect");
        // Configuration.toString supplies Android's own Float.toString, not a host approximation.
        await putRow(
          context,
          ROWS.font_scale[0] as RowSpec,
          user,
          value === "unset" ? null : settled.value,
        );
        let stableRows = 0;
        const rowsSettled = await observe({
          deadline: context.deadline,
          windowMs: 5000,
          read: async () => readRows(context, ROWS.font_scale, user),
          done: (rows) => {
            stableRows = (
              value === "unset" ? rows[0]?.present === false : rows[0]?.text === settled.value
            )
              ? stableRows + 1
              : 0;
            return stableRows >= 2;
          },
        });
        if (!rowsSettled.ok)
          throw new AdbAxiError(
            "CONFIG_MISMATCH",
            "Font-scale row did not remain in the requested state",
          );
      },
    );
  }
  for (const [index, row] of ROWS[key].entries()) {
    const item = values[index] ?? "";
    if (key === "animations") {
      if (item === "unset") {
        // Deletion alone retains WindowManager's previous in-memory scale.
        await putRow(context, row, user, "1");
        await readRows(context, [row], user);
      }
      await putRow(context, row, user, item === "unset" ? null : item);
    } else if (item === "unset" && (key === "density" || key === "size"))
      await putRow(context, row, user, null);
  }
}
export async function verify(
  context: DeviceContext,
  key: ConfigKey,
  values: string[],
  before: Snapshot,
  after: Snapshot,
  user: number,
): Promise<void> {
  const value = values[0] ?? "";
  let matches = after.rows.every((row, index) => {
    const desired = values[index] ?? "";
    if (desired === "unset") return !row.present;
    if (key === "night") return row.present && NIGHT[row.text ?? ""] === desired;
    if (desired === "reset") return row.present && row.text === "";
    if (key === "size") return row.present;
    if (key === "density" || key === "font_scale")
      return (
        row.present &&
        ((row.text === "" && key === "density") ||
          Math.fround(Number(row.text)) === Math.fround(Number(desired)))
      );
    return row.present && row.text === desired;
  });
  if (key === "font_scale")
    matches &&=
      Math.fround(Number(after.effective)) === Math.fround(Number(value === "unset" ? "1" : value));
  if (key === "night") matches &&= after.effective === (value === "unset" ? "no" : value);
  if (key === "size" || key === "density") {
    const state = await display(context, key);
    if (["unset", "reset"].includes(value)) matches &&= after.effective === state.physical;
    else {
      const expected = key === "density" ? String(Number(value)) : await pixelSize(context, value);
      matches &&= after.effective === expected;
      const rawExpected =
        expected === state.physical ? "" : key === "size" ? expected.replace("x", ",") : expected;
      matches &&= after.rows[0]?.text === rawExpected;
    }
  }
  if (!matches) {
    const locked =
      key === "night" && /mNightModeLocked=true/.test(await shell(context, "dumpsys uimode"));
    throw new AdbAxiError(
      "CONFIG_MISMATCH",
      locked
        ? "Night mode is locked by this device; requested value did not take effect"
        : "Device configuration readback did not match the requested value",
      {
        fields: { key, user, requested: values, before, after },
        help: [
          "Restore with config set <key> <before.value> on this device in the same turn; no automatic rollback was attempted",
        ],
      },
    );
  }
}
