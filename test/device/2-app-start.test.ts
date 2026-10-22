import { beforeAll, describe, expect, test } from "vitest";
import { sharedWithToon } from "../helpers/json.js";
import { Axi, DEBUG_APK, PKG, probeState } from "./support.js";

const axi = new Axi(import.meta.filename);

interface StartedApp {
  activity: string;
  pid: number;
  launch: string;
  recreated: boolean;
}

function app(data: Record<string, unknown>): StartedApp {
  return data.app as StartedApp;
}

async function fresh(): Promise<void> {
  await axi.ok(["app", "clear", PKG]);
  expect(await axi.pidsOf(PKG)).toEqual([]);
}

/** The package whose window has input focus, read from the window manager. */
async function packageInFront(accept: (pkg: string) => boolean): Promise<string> {
  const component = await axi.waitFocused((value) => accept(value.split("/")[0] ?? ""));
  return component.split("/")[0] ?? "";
}

describe("app start", () => {
  beforeAll(async () => {
    await axi.ok(["app", "install", DEBUG_APK, "--clean-data"]);
  });

  test("an app already in front is not recreated, --fresh cold-starts it", async () => {
    const first = await axi.ok(["app", "start", PKG]);
    expect(first.app).toMatchObject({ launch: "cold", recreated: true });
    await axi.ok(["wait", "app", PKG, "--state", "foreground"]);
    const component = await axi.waitFocused((value) => value === `${PKG}/.MainActivity`);
    expect(first.ok).toContain(`start ${PKG} -> foreground`);
    expect(first.app).toMatchObject({ activity: component.split("/")[1] });
    expect(await axi.pidsOf(PKG)).toEqual([(first.app as { pid: number }).pid]);

    await axi.mark("before-inc");
    await axi.probe("inc");
    expect(probeState(await axi.waitLog("event=inc saved=1 ", "before-inc"))).toMatchObject({
      saved: "1",
      volatile: "1",
    });
    const again = await axi.ok(["app", "start", PKG]);
    expect(again.app).toMatchObject({
      recreated: false,
      pid: (first.app as { pid: number }).pid,
    });

    expect(again).toMatchObject({
      ok: `start ${PKG} -> foreground (already on top, intent delivered to it)`,
      app: { activity: ".MainActivity", launch: "unknown" },
      help: [
        `Run \`adb-axi app start ${PKG} --device ${axi.serial} --fresh\` to kill the process and cold-start`,
      ],
    });
    expect((await axi.text(["app", "start", PKG])).data).toEqual(sharedWithToon(again));
    await axi.mark("after-again");
    await axi.probe("state");
    expect(probeState(await axi.waitLog("event=state ", "after-again"))).toMatchObject({
      saved: "1",
      volatile: "1",
      pid: String((first.app as { pid: number }).pid),
    });

    await axi.mark("before-fresh");
    const fresh = await axi.ok(["app", "start", PKG, "--fresh"]);
    expect(fresh.app).toMatchObject({ launch: "cold", recreated: true });
    expect((fresh.app as { pid: number }).pid).not.toBe((first.app as { pid: number }).pid);
    expect(probeState(await axi.waitLog("event=start ", "before-fresh"))).toMatchObject({
      saved: "0",
      volatile: "0",
      restored: "false",
      pid: String((fresh.app as { pid: number }).pid),
    });
  });
});

describe("app start on activities other than the launcher", () => {
  test("a named activity starts by slash or --activity, a nested class too, and :ui runs in its own process", async () => {
    await fresh();
    const main = await axi.ok(["app", "start", PKG]);
    expect(app(main)).toMatchObject({ activity: ".MainActivity", launch: "cold" });

    const ui = await axi.ok(["app", "start", PKG, "--activity", ".UiActivity"]);
    expect(ui.ok).toBe(`start ${PKG} -> foreground (cold start)`);
    await axi.waitFocused((component) => component === `${PKG}/.UiActivity`);
    const [uiPid] = await axi.pidsOf(`${PKG}:ui`);
    expect(app(ui)).toMatchObject({ activity: ".UiActivity", pid: uiPid, recreated: true });
    expect(await axi.pidsOf(PKG)).toEqual([app(main).pid]);

    const nested = (await axi.text(["app", "start", `${PKG}/.Outer$Inner`])).data;
    expect(nested.ok).toBe(`start ${PKG} -> foreground (warm start)`);
    expect(app(nested)).toMatchObject({ activity: ".Outer$Inner", pid: app(main).pid });
    await axi.waitFocused((component) => component === `${PKG}/.Outer$Inner`);

    await axi.sh("input keyevent KEYCODE_HOME");
    await axi.waitFocused((component) => !component.startsWith(`${PKG}/`));
    const hot = await axi.ok(["app", "start", PKG]);
    expect(["hot", "unknown"]).toContain(app(hot).launch);
    expect(hot).toEqual({
      ok: `start ${PKG} -> foreground (existing task brought to front)`,
      noop: false,
      app: {
        activity: ".Outer$Inner",
        pid: app(main).pid,
        launch: app(hot).launch,
        recreated: false,
      },
      help: [
        `Run \`adb-axi app start ${PKG} --device ${axi.serial} --fresh\` to kill the process and cold-start`,
      ],
    });
    await axi.waitFocused((component) => component === `${PKG}/.Outer$Inner`);

    const stopped = await axi.ok(["app", "stop", PKG]);
    const named = /^stop dev\.probe -> not running \(pids (\d+) (\d+) gone after \d+ ms\)$/.exec(
      String(stopped.ok),
    );
    expect(named, String(stopped.ok)).not.toBeNull();
    expect(
      named
        ?.slice(1)
        .map(Number)
        .sort((a, b) => a - b),
    ).toEqual([app(main).pid, uiPid].sort((a, b) => (a ?? 0) - (b ?? 0)));
    expect(await axi.pidsOf(PKG)).toEqual([]);
    expect(await axi.pidsOf(`${PKG}:ui`)).toEqual([]);
  });

  test("an alias launcher entry starts its target, and a second start reaches the instance on top", async () => {
    await fresh();
    await axi.ok(["app", "start", PKG]);
    await axi.mark("alias");
    await axi.probe("alias", "--ez on true");
    await axi.waitLog("event=alias on=true ", "alias");
    try {
      const launchers = await axi.sh(
        `cmd package query-activities --components -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -p ${PKG}`,
      );
      expect(launchers.split("\n")).toEqual([`${PKG}/.MainActivity`, `${PKG}/.Alias`]);
      await axi.ok(["app", "stop", PKG]);
      const started = await axi.ok(["app", "start", PKG]);
      expect(app(started)).toMatchObject({ activity: ".MainActivity", launch: "cold" });

      for (let i = 0; i < 2; i++) {
        const alias = await axi.ok(["app", "start", `${PKG}/.Alias`]);
        expect(alias).toEqual({
          ok: `start ${PKG} -> foreground (already on top, intent delivered to it)`,
          noop: false,
          app: {
            activity: ".MainActivity",
            pid: app(started).pid,
            launch: "unknown",
            recreated: false,
          },
          help: [
            `Run \`adb-axi app start ${PKG}/.Alias --device ${axi.serial} --fresh\` to kill the process and cold-start`,
          ],
        });
        expect(await axi.pidsOf(PKG)).toEqual([app(started).pid]);
      }
    } finally {
      await axi.probe("alias", "--ez on false");
    }
  });

  test("the app starts but another app is in front: Settings over it, or the permission controller", async () => {
    await fresh();
    for (const [activity, expectFront, format] of [
      [".BounceActivity", (pkg: string) => pkg === "com.android.settings", "json"],
      [".PermActivity", (pkg: string) => pkg.endsWith(".permissioncontroller"), "toon"],
    ] as const) {
      const args = ["app", "start", `${PKG}/${activity}`];
      const run =
        format === "json" ? sharedWithToon(await axi.ok(args)) : (await axi.text(args)).data;
      const front = await packageInFront(expectFront);
      const [pid] = await axi.pidsOf(PKG);
      expect(run).toMatchObject({
        ok: `start ${PKG} -> running, ${front} in front`,
        app: { activity, pid },
        help: [`Run \`adb-axi app current --device ${axi.serial}\` to see what is in front`],
      });
      await axi.ok(["app", "stop", PKG]);
      await axi.sh("input keyevent KEYCODE_HOME");
    }
  });

  test("start refusals: a missing activity, no launcher activity and a private activity", async () => {
    await fresh();
    const missing = await axi.fails(["app", "start", `${PKG}/.Missing`], "ACTIVITY_NOT_FOUND");
    expect(missing).toMatchObject({
      error: `${PKG} has no activity .Missing`,
      help: [
        `Run \`adb-axi app start ${PKG}/.MainActivity --device ${axi.serial}\` to start a listed activity`,
      ],
    });
    expect(missing.activities).toContain(".MainActivity");
    expect(await axi.pidsOf(PKG)).toEqual([]);

    const provider = "com.android.providers.settings";
    expect(
      (
        await axi.sh(
          `cmd package query-activities --components -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -p ${provider}`,
        )
      ).trim(),
    ).toBe("No activities found");
    expect(await axi.fails(["app", "start", provider], "ACTIVITY_NOT_FOUND")).toMatchObject({
      error: `${provider} has no launcher activity`,
      activities: [],
    });

    const refused = await axi.fails(["app", "start", `${PKG}/.PrivateActivity`], "REMOTE_EXIT", {
      varies: ["detail"],
    });
    expect(refused).toMatchObject({
      step: `starting ${PKG}/.PrivateActivity`,
      detail: expect.stringMatching(/SecurityException|Permission Denial/) as string,
    });
    expect(await axi.pidsOf(PKG)).toEqual([]);
  });
});
