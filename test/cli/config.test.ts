import { afterEach, expect, test } from "vitest";
import { createFakeAdb, type FakeAdb } from "../fake-adb/harness.js";
import type { Rule } from "../fake-adb/scenario.js";
import { runCli } from "../helpers/run.js";

const SERIAL = "emulator-5554";
const rows = (window: string) =>
  `window_animation_scale=${window}\ntransition_animation_scale=1\nanimator_duration_scale=1\n`;
let fake: FakeAdb | undefined;
afterEach(() => {
  fake?.cleanup();
  fake = undefined;
});
function device(rules: Rule[], source?: string): FakeAdb {
  fake = createFakeAdb({
    description:
      "Fault boundary: a selective settings write refusal or a user switch between snapshot and mutation cannot be safely scheduled on a real emulator",
    synthetic: true,
    ...(source === undefined ? {} : { source }),
    rules: [
      {
        match: ["devices", "-l"],
        respond: {
          stdout: `List of devices attached\n${SERIAL} device product:sdk_gphone64_arm64\n`,
        },
      },
      ...rules,
    ],
  });
  return fake;
}
const call = (command: string) => ["-s", SERIAL, "shell", command];

test("Android 15 custom schedule output remains readable but not restorable", async () => {
  const f = device(
    [
      { match: call("am get-current-user"), respond: { stdout: "0\n" } },
      { match: call("settings --user 0 list secure"), respond: { stdout: "ui_night_mode=3\n" } },
      { match: call("cmd uimode night"), respond: { stdout: "Night mode: custom_schedule\n" } },
    ],
    "https://github.com/aosp-mirror/platform_frameworks_base/blob/android-15.0.0_r1/services/core/java/com/android/server/UiModeManagerService.java: Shell.nightModeToStr; local API35 image is unauthorized",
  );
  const result = await runCli(["config", "get", "night", "--device", SERIAL, "--json"], f.env);
  expect(result.exitCode).toBe(0);
  const data = JSON.parse(result.stdout) as Record<string, unknown>;
  expect(data.config).toMatchObject([
    { effective: "custom_schedule", value: null, rows: [{ present: true, text: "3" }] },
  ]);
});

test("a partial animations refusal reports both the original and independently remaining rows", async () => {
  const f = device([
    { match: call("am get-current-user"), respond: { stdout: "0\n" } },
    {
      match: call("settings list global"),
      when: { changed: "yes" },
      respond: { stdout: rows("0") },
    },
    { match: call("settings list global"), respond: { stdout: rows("1") } },
    {
      match: call("settings put global window_animation_scale 0"),
      set: { changed: "yes" },
      respond: {},
    },
    {
      match: call("settings put global transition_animation_scale 0"),
      respond: { exit: 1, stderr: "settings provider refused write" },
    },
  ]);
  const result = await runCli(
    ["config", "set", "animations", "0", "--device", SERIAL, "--json"],
    f.env,
  );
  expect(result.exitCode).toBe(1);
  const data = JSON.parse(result.stdout) as Record<string, unknown>;
  expect(data.code).toBe("REMOTE_EXIT");
  expect(data.before).toMatchObject({ value: "window=1,transition=1,animator=1" });
  expect(data.after).toMatchObject({ value: "window=0,transition=1,animator=1" });
});

test("a user switch before mutation says no write attempted and never suggests restoration on the new user", async () => {
  const f = device([
    {
      match: call("am get-current-user"),
      times: 1,
      respond: { stdout: "0\n" },
      then: { stdout: "10\n" },
    },
    { match: call("settings list global"), respond: { stdout: rows("1") } },
  ]);
  const result = await runCli(
    ["config", "set", "animations", "0", "--device", SERIAL, "--json"],
    f.env,
  );
  expect(result.exitCode).toBe(2);
  const data = JSON.parse(result.stdout) as Record<string, unknown>;
  expect(data).toMatchObject({ code: "VALIDATION_ERROR", user: 0, current: "10" });
  expect(data.error).toMatch(/no write attempted/);
  expect(data.help).toBeUndefined();
  expect(
    f.calls().some((entry) => /^settings .*\b(?:put|delete)\b/.test(entry.argv[3] ?? "")),
  ).toBe(false);
});
