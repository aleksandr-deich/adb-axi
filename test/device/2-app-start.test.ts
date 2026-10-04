import { beforeAll, describe, expect, test } from "vitest";
import { Axi, DEBUG_APK, PKG } from "./support.js";

const axi = new Axi(import.meta.filename);

describe("app start", () => {
  beforeAll(async () => {
    await axi.ok(["app", "install", DEBUG_APK, "--clean-data"]);
  });

  test("an app already in front is not recreated, --fresh cold-starts it", async () => {
    const first = await axi.ok(["app", "start", PKG]);
    expect(first.app).toMatchObject({ launch: "cold", recreated: true });
    await axi.ok(["wait", "app", PKG, "--state", "foreground"]);

    const again = await axi.ok(["app", "start", PKG]);
    expect(again.app).toMatchObject({
      recreated: false,
      pid: (first.app as { pid: number }).pid,
    });

    const fresh = await axi.ok(["app", "start", PKG, "--fresh"]);
    expect(fresh.app).toMatchObject({ launch: "cold", recreated: true });
    expect((fresh.app as { pid: number }).pid).not.toBe((first.app as { pid: number }).pid);
  });
});
