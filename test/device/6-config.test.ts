import { expect, test } from "vitest";
import { Axi } from "./support.js";

const axi = new Axi(import.meta.filename);
const keys = ["animations", "night", "font_scale", "density", "size"] as const;
type Key = (typeof keys)[number];
interface State {
  rows: { name: string; present: boolean; text: string | null }[];
  value: string | null;
  effective: unknown;
}
async function get(key: Key): Promise<State> {
  const result = await axi.ok(["config", "get", key]);
  const state = (result.config as State[])[0];
  if (state === undefined) throw new Error("config get returned no state");
  return { rows: state.rows, value: state.value, effective: state.effective };
}
async function independent(): Promise<string> {
  return axi.sh(
    "for ns in global secure system; do echo @$ns; settings --user $(am get-current-user) list $ns | grep -E '^(window_animation_scale|transition_animation_scale|animator_duration_scale|ui_night_mode[^=]*|dark_theme_[^=]*|font_scale|system_locales|display_density_forced|display_size_forced)=' | sort; done; wm density; wm size; cmd uimode night",
  );
}
async function restore(key: Key, value: string | null): Promise<void> {
  expect(value, `restorable original ${key}`).not.toBeNull();
  if (value === null) throw new Error(`Original ${key} is not restorable`);
  await axi.ok(["config", "set", key, value]);
}

test("all keys report raw rows; each set restores its printed before and identical independent state", async () => {
  const initial = await independent();
  const listing = await axi.ok(["config", "get"]);
  expect((listing.config as { key: string }[]).map((item) => item.key)).toEqual(keys);
  expect(listing.user).toBe(Number((await axi.sh("am get-current-user")).trim()));
  const locked = /mNightModeLocked=true/.test(await axi.sh("dumpsys uimode"));
  const api = Number((await axi.sh("getprop ro.build.version.sdk")).trim());
  const values = {
    animations: "0.25",
    night: "yes",
    font_scale: "1.15",
    density: "320",
    size: "800x1200",
  };
  for (const key of keys) {
    const original = await get(key);
    const rawBefore = await independent();
    try {
      const result = await axi.run(["config", "set", key, values[key]]);
      expect(result.json.before).toEqual(original);
      if (key === "night" && locked && api === 29) {
        expect(result.exitCode).toBe(1);
        expect(result.json.code).toBe("CONFIG_MISMATCH");
        expect(result.json.error).toMatch(/locked/i);
        expect(await independent()).toBe(rawBefore);
      } else {
        expect(result.exitCode, result.stdout).toBe(0);
        const after = result.json.after as State;
        expect(after.rows.every((row) => row.present)).toBe(true);
        const raw = await independent();
        if (key === "animations") expect(raw).toContain("animator_duration_scale=0.25");
        if (key === "night") expect(raw).toContain("ui_night_mode=2");
        if (key === "font_scale") expect(raw).toContain("font_scale=1.15");
        if (key === "density") expect(raw).toContain("Override density: 320");
        if (key === "size") expect(raw).toContain("Override size: 800x1200");
      }
    } finally {
      await restore(key, original.value);
    }
    expect(await independent()).toBe(rawBefore);
  }
  for (const [value, expected] of [
    ["2", "2.0"],
    ["1", "1.0"],
    [".5", "0.5"],
    ["1.50", "1.5"],
    ["1e0", "1.0"],
  ]) {
    const original = await get("font_scale");
    try {
      const changed = await axi.ok(["config", "set", "font_scale", value ?? ""]);
      expect((changed.after as State).rows[0]?.text).toBe(expected);
      expect(await axi.sh("settings --user $(am get-current-user) get system font_scale")).toBe(
        expected,
      );
    } finally {
      await restore("font_scale", original.value);
    }
    expect(await independent()).toBe(initial);
  }
  const density = await get("density");
  const size = await get("size");
  try {
    for (const key of ["density", "size"] as const) {
      const physical = new RegExp(`^Physical ${key}: (.+)$`, "m").exec(await independent())?.[1];
      if (physical === undefined) throw new Error(`No physical ${key}`);
      const changed = await axi.ok(["config", "set", key, physical]);
      expect((changed.after as State).effective).toBe(physical);
      expect((changed.after as State).rows[0]?.text).toBe("");
    }
    await axi.ok(["config", "set", "density", "320"]);
    const changed = await axi.ok(["config", "set", "size", "400dpx800dp"]);
    expect((changed.after as State).effective).toBe("800x1600");
    expect(await axi.sh("wm size")).toContain("Override size: 800x1600");
  } finally {
    await restore("size", size.value);
    await restore("density", density.value);
  }
  if (api >= 30) {
    const night = await get("night");
    try {
      await axi.ok(["config", "set", "night", "auto"]);
    } finally {
      await restore("night", night.value);
    }
  }
  expect(await independent()).toBe(initial);
});

test("absent animator row differs from a present literal null, and unset restores absence", async () => {
  const initial = await independent();
  const original = await get("animations");
  try {
    await axi.sh("settings delete global animator_duration_scale");
    const absent = await get("animations");
    expect(absent.rows.find((row) => row.name === "animator_duration_scale")).toMatchObject({
      present: false,
      text: null,
    });
    const changed = await axi.ok(["config", "set", "animations", "0"]);
    expect((changed.before as State).value).toContain("animator=unset");
    await restore("animations", (changed.before as State).value);
    expect(await axi.sh("settings list global | grep '^animator_duration_scale=' || true")).toBe(
      "",
    );
    await axi.sh("settings put global animator_duration_scale null");
    const literal = await get("animations");
    expect(literal.rows.find((row) => row.name === "animator_duration_scale")).toMatchObject({
      present: true,
      text: "null",
    });
    await axi.sh("settings put global animator_duration_scale unset");
    expect((await get("animations")).value).toBeNull();
    const beforeRefusal = await independent();
    const refused = await axi.run(["config", "set", "animations", "0"]);
    expect(refused.exitCode).toBe(1);
    expect(refused.json.code).toBe("INVALID_OUTPUT");
    expect(await independent()).toBe(beforeRefusal);
  } finally {
    await axi.sh("settings delete global animator_duration_scale");
    await restore("animations", original.value);
  }
  expect(await independent()).toBe(initial);
});

test("heterogeneous animation scales and absence restore exactly from before.value", async () => {
  const initial = await independent();
  const original = await get("animations");
  try {
    await axi.ok(["config", "set", "animations", "window=unset,transition=1.25,animator=0.5"]);
    const heterogeneous = await independent();
    const changed = await axi.ok(["config", "set", "animations", "0"]);
    expect((changed.before as State).value).toBe("window=unset,transition=1.25,animator=0.5");
    await restore("animations", (changed.before as State).value);
    expect(await independent()).toBe(heterogeneous);
  } finally {
    await restore("animations", original.value);
  }
  expect(await independent()).toBe(initial);
});

test("invalid key values fail with usage errors without changing settings", async () => {
  const initial = await independent();
  const invalid: [string, string][] = [
    ["animations", "-1"],
    ["animations", "NaN"],
    ["animations", "Infinity"],
    ["animations", "window=0,transition=1,animator=-1"],
    ["night", "maybe"],
    ["font_scale", "0"],
    ["font_scale", "-1"],
    ["density", "71"],
    ["density", "320;echo bad"],
    ["size", "0x100"],
    ["size", "wide"],
    ["size", "1x1"],
    ["size", "10000x10000"],
    ["size", "2147483647dpx1"],
  ];
  const physical = /^Physical size: (\d+)x(\d+)$/m.exec(initial);
  if (physical === null) throw new Error("No physical size");
  invalid.push(["size", `${Number(physical[1]) * 2 + 1}x${physical[2]}`]);
  for (const [key, value] of invalid) {
    const result = await axi.run(["config", "set", key, value]);
    expect(result.exitCode, result.stdout).toBe(2);
    expect(result.json.code).toBe("VALIDATION_ERROR");
  }
  expect(await independent()).toBe(initial);
});
