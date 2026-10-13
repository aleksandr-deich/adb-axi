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

    const ps = `rows=$(ps -A -o PID,UID,NAME,STAT) && printf '%s\\n' "$rows" | awk 'NR == 1 || $3 == "${PKG}" || $3 == "[${PKG}]" || index($3, "${PKG}:") == 1 || index($3, "[${PKG}:") == 1'`;
    await axi.ok(["shell", ps]);
    await axi.ok(["shell", `pidof ${PKG}`]);
    const [killed] = await Promise.allSettled([axi.ok(["app", "kill", PKG])]);
    const diagnostics = await Promise.allSettled([
      axi.ok(["shell", ps]),
      axi.run(["shell", `pidof ${PKG}`]).then((run) => {
        if (run.exitCode === 0) return;
        expect(run.exitCode, run.stdout + run.stderr).toBe(1);
        expect(run.json).toMatchObject({ code: "REMOTE_EXIT", exit: 1 });
        expect(run.json.stdout === undefined || run.json.stdout === "").toBe(true);
      }),
      axi.ok(["logs", "--pkg", PKG, "--since", "before-kill"]),
    ]);
    const failures = diagnostics
      .filter((result) => result.status === "rejected")
      .map((result: { reason: unknown }) => result.reason);
    if (killed.status === "rejected") {
      if (failures.length === 0) throw killed.reason;
      throw new AggregateError([killed.reason, ...failures], "App kill and diagnostics failed");
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Post-kill diagnostics failed");
    const kill = killed.value;
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
