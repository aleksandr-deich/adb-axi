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
  effective: string | Record<string, number>;
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
  const value = /^Night mode: (yes|no|auto|custom)\s*$/.exec(output)?.[1];
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
  if (key === "animations") {
    effective = Object.fromEntries(
      rows.map((item) => [
        item.alias,
        item.text !== null && isScale(item.text, false) ? Math.fround(Number(item.text)) : 1,
      ]),
    );
  } else if (key === "font_scale") effective = await fontScale(context);
  else if (key === "night") effective = await nightMode(context);
  else effective = (await display(context, key)).effective;
  const tokens = rows.map((item): string | null => {
    if (!item.present) return key === "night" && effective !== "no" ? null : "unset";
    const text = item.text;
    if (text === null) return null;
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
      return token;
    } catch {
      return null;
    }
  });
  return {
    rows,
    effective,
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
async function writeNight(context: DeviceContext, value: string, user: number): Promise<void> {
  const companions = await readRows(context, NIGHT_COMPANIONS, user);
  let writeError: Error | undefined;
  try {
    const desired = value === "unset" ? "no" : value;
    await shell(context, `cmd uimode night ${desired}`);
    // A locked device can silently refuse the command; do not make its settings claim otherwise.
    if ((await nightMode(context)) === desired && value !== "unset") {
      const code = Object.entries(NIGHT).find(([, name]) => name === value)?.[0];
      if (code !== undefined) await putRow(context, ROWS.night[0] as RowSpec, user, code);
    }
  } catch (error) {
    writeError =
      error instanceof Error
        ? error
        : new AdbAxiError("INTERNAL_ERROR", "Night-mode write failed", {
            fields: { detail: String(error) },
          });
  }
  const changed = await readRows(context, NIGHT_COMPANIONS, user);
  for (const [index, row] of companions.entries()) {
    if (changed[index]?.present !== row.present || changed[index].text !== row.text)
      await putRow(context, row, user, row.text);
  }
  const restored = await readRows(context, NIGHT_COMPANIONS, user);
  if (
    restored.some(
      (row, index) =>
        row.present !== companions[index]?.present || row.text !== companions[index].text,
    )
  ) {
    throw new AdbAxiError("CONFIG_MISMATCH", "Night-mode companion rows could not be preserved", {
      fields: { companions_before: companions, companions_after: restored },
    });
  }
  if (writeError !== undefined) throw writeError;
}
export async function writeConfig(
  context: DeviceContext,
  key: ConfigKey,
  values: string[],
  user: number,
): Promise<void> {
  // wm uses the foreground user implicitly; refuse a switch rather than target another user.
  const current = (await shell(context, "am get-current-user")).trim();
  if (current !== String(user))
    throw new AdbAxiError("CONFIG_MISMATCH", "Android user changed before the config write", {
      fields: { user, current },
    });
  const value = values[0] ?? "";
  if (key === "night") await writeNight(context, value, user);
  if (key === "density" || key === "size")
    await shell(context, `wm ${key} ${value === "unset" ? "reset" : value}`);
  if (key === "font_scale") {
    // Android rewrites font_scale after a configuration change; settle the default before deleting its row.
    const desired = value === "unset" ? "1" : value;
    await putRow(context, ROWS.font_scale[0] as RowSpec, user, desired);
    const settled = await observe({
      deadline: context.deadline,
      windowMs: 5000,
      read: async () => fontScale(context),
      done: (effective) => Math.fround(Number(effective)) === Math.fround(Number(desired)),
    });
    if (!settled.ok)
      throw new AdbAxiError("CONFIG_MISMATCH", "Requested font scale did not take effect");
  }
  for (const [index, row] of ROWS[key].entries()) {
    const item = values[index] ?? "";
    if (item === "unset") await putRow(context, row, user, null);
    else if (key === "animations") await putRow(context, row, user, item);
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
    if (key === "density") return row.present && Number(row.text) === Number(desired);
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
      let expected =
        key === "density"
          ? String(Number(value))
          : value
              .split("x")
              .map((part) => String(Number(part)))
              .join("x");
      if (key === "size" && value.includes("dp")) {
        const density = await display(context, "density");
        expected = value
          .split("x")
          .map((part) =>
            part.endsWith("dp")
              ? Math.trunc((Number.parseInt(part, 10) * Number(density.physical)) / 160)
              : Number(part),
          )
          .join("x");
      }
      matches &&= after.effective === expected;
      if (key === "size") matches &&= after.rows[0]?.text === expected.replace("x", ",");
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
