import { describe, expect, test } from "vitest";
import { Axi, DEBUG_APK, PKG } from "./support.js";

const axi = new Axi(import.meta.filename);

const modes = [
  { dialogs: "shown", setting: null },
  { dialogs: "hidden", setting: "1" },
] as const;

/** Run `check` with Android's crash dialogs shown or hidden, restoring the setting after. */
async function withDialogs(setting: string | null, check: () => Promise<void>): Promise<void> {
  const original = (await axi.sh("settings get global hide_error_dialogs")).trim();
  expect(original).toMatch(/^(null|\d+)$/);
  try {
    await axi.sh(
      setting === null
        ? "settings delete global hide_error_dialogs"
        : `settings put global hide_error_dialogs ${setting}`,
    );
    await check();
  } finally {
    await dismiss();
    await axi.sh(
      original === "null"
        ? "settings delete global hide_error_dialogs"
        : `settings put global hide_error_dialogs ${original}`,
    );
    expect((await axi.sh("settings get global hide_error_dialogs")).trim()).toBe(original);
  }
}

/** Close a crash dialog Android may be showing, and end whatever is left of the probe. */
async function dismiss(): Promise<void> {
  await axi.sh("am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS > /dev/null");
  await axi.ok(["app", "stop", PKG]);
}

/** Start the probe and arm it so its next MainActivity create throws. */
async function arm(): Promise<void> {
  await dismiss();
  const mark = `arm-${Date.now()}`;
  await axi.ok(["app", "start", PKG]);
  await axi.mark(mark);
  await axi.probe("armcrash");
  await axi.waitLog("event=armcrash ", mark);
}

async function crashedOnCreate(since: string, count: number): Promise<void> {
  const report = await axi.sh(
    `logcat -d -b crash -T '${since}' | grep -c 'Caused by: java.lang.IllegalStateException: probe armed crash on create' || true`,
  );
  expect(Number(report.trim())).toBe(count);
}

describe("an app that crashes while it launches", () => {
  for (const { dialogs, setting } of modes) {
    test(`start reports APP_DIED_ON_START with crash dialogs ${dialogs}`, async () => {
      await axi.ok(["app", "install", DEBUG_APK, "--clean-data"]);
      await withDialogs(setting, async () => {
        const since = await axi.mark("launch");
        const died = await axi.fails(["app", "start", PKG], "APP_DIED_ON_START", {
          varies: ["last"],
          before: async () => {
            await arm();
            await axi.ok(["app", "stop", PKG]);
          },
        });
        expect(died).toMatchObject({
          error: `the ${PKG} process of ${PKG}/.MainActivity is gone right after its start`,
          last: { state: "stopped", pid: "-" },
          help: [
            `Run \`adb-axi logs crash --pkg ${PKG} --since 1m --device ${axi.serial}\` for the crash`,
            `Run \`adb-axi app start ${PKG} --device ${axi.serial} --fresh\` to try a cold start`,
          ],
        });
        await crashedOnCreate(since, 2);
      });
    });

    test(`restore reports APP_DIED_ON_START with crash dialogs ${dialogs}`, async () => {
      await axi.ok(["app", "install", DEBUG_APK, "--clean-data"]);
      await withDialogs(setting, async () => {
        const since = await axi.mark("restore");
        const died = await axi.fails(["app", "restore", PKG], "APP_DIED_ON_START", {
          varies: ["last"],
          before: async () => {
            await arm();
            await axi.ok(["app", "kill", PKG]);
          },
        });
        expect(died).toMatchObject({
          error: `the ${PKG} process of ${PKG}/.MainActivity is gone right after its restore`,
          last: { state: "stopped", pid: "-" },
          help: [
            `Run \`adb-axi logs crash --pkg ${PKG} --since 1m --device ${axi.serial}\` for the crash`,
          ],
        });
        await crashedOnCreate(since, 2);
      });
    });
  }
});
