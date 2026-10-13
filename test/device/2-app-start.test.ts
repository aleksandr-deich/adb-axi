import { beforeAll, describe, expect, test } from "vitest";
import { sharedWithToon } from "../helpers/json.js";
import { Axi, DEBUG_APK, PKG, probeState } from "./support.js";

const axi = new Axi(import.meta.filename);

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
