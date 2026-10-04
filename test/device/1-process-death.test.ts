import { beforeAll, describe, expect, test } from "vitest";
import { Axi, DEBUG_APK, PKG, probeState } from "./support.js";

const axi = new Axi(import.meta.filename);

describe("process death and restore", () => {
  beforeAll(async () => {
    await axi.ok(["app", "install", DEBUG_APK, "--clean-data"]);
  });

  test("the saved counter survives app kill and app restore, the volatile one resets", async () => {
    await axi.mark("before-kill");
    for (let i = 0; i < 3; i++) await axi.probe("inc");
    const before = probeState(await axi.waitLog("event=inc saved=3 ", "before-kill"));
    expect(before).toMatchObject({ saved: "3", volatile: "3" });

    const kill = await axi.ok(["app", "kill", PKG]);
    expect(kill.kill).toMatchObject({ pid_before: Number(before.pid), pid_after: null });
    expect((kill.kill as { cached_after_ms: unknown }).cached_after_ms).toEqual(expect.any(Number));

    await axi.mark("before-restore");
    const restore = await axi.ok(["app", "restore", PKG]);
    expect(restore.app).toMatchObject({ launch: "cold", new_process: true });
    const after = probeState(await axi.waitLog("event=start .*restored=true ", "before-restore"));
    expect(after).toMatchObject({ saved: "3", volatile: "0", restored: "true" });
    expect(after.pid).toBe(String((restore.app as { pid: number }).pid));
    expect(after.pid).not.toBe(before.pid);

    expect((await axi.crashes("before-kill")).count).toBe(0);
  });
});
