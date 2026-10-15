import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { sharedWithToon } from "../helpers/json.js";
import { Axi, DEBUG_APK, PKG, RELEASE_APK, probeState } from "./support.js";

const axi = new Axi(import.meta.filename);

describe("process death and restore", () => {
  beforeAll(async () => {
    await axi.ok(["app", "install", DEBUG_APK, "--clean-data"]);
  });

  test("the saved counter survives app kill and app restore, the volatile one resets", async () => {
    for (const format of ["json", "toon"]) {
      await axi.ok(["app", "install", DEBUG_APK, "--clean-data"]);
      await axi.mark("before-kill");
      for (let i = 0; i < 3; i++) await axi.probe("inc");
      const before = probeState(await axi.waitLog("event=inc saved=3 ", "before-kill"));
      expect(before).toMatchObject({ saved: "3", volatile: "3" });

      const ps = `rows=$(ps -A -o PID,UID,NAME,STAT) && printf '%s\\n' "$rows" | awk 'NR == 1 || $3 == "${PKG}" || $3 == "[${PKG}]" || index($3, "${PKG}:") == 1 || index($3, "[${PKG}:") == 1'`;
      await axi.ok(["shell", ps]);
      await axi.ok(["shell", `pidof ${PKG}`]);
      const activity = `dump=$(dumpsys activity processes) && { printf '%s\\n' "$dump" | grep -F '${PKG}' || true; }`;
      await axi.ok(["shell", activity]);
      const [killed] = await Promise.allSettled([
        format === "json"
          ? axi.ok(["app", "kill", PKG])
          : axi.text(["app", "kill", PKG]).then((run) => run.data),
      ]);
      const diagnostics = await Promise.allSettled([
        axi.ok(["shell", ps]),
        axi.ok(["shell", activity]),
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
      expect((kill.kill as { cached_after_ms: unknown }).cached_after_ms).toEqual(
        expect.any(Number),
      );

      await axi.mark("before-restore");
      const restore =
        format === "json"
          ? await axi.ok(["app", "restore", PKG])
          : (await axi.text(["app", "restore", PKG])).data;
      expect(restore.ok).toBe(`restore ${PKG} -> foreground from recents (new process)`);
      expect(restore.app).toMatchObject({
        activity: ".MainActivity",
        launch: "cold",
        new_process: true,
      });
      await axi.waitFocused((component) => component === `${PKG}/.MainActivity`);
      const after = probeState(await axi.waitLog("event=start .*restored=true ", "before-restore"));
      expect(after).toMatchObject({ saved: "3", volatile: "0", restored: "true" });
      expect(after.pid).toBe(String((restore.app as { pid: number }).pid));
      expect(after.pid).not.toBe(before.pid);
      expect(await axi.pidsOf(PKG)).toEqual([Number(after.pid)]);

      expect((await axi.crashes("before-kill")).count).toBe(0);
    }
  });
});

describe("kill, restore and death at their edges", () => {
  async function twoProcesses(apk: string): Promise<{ main: number; ui: number }> {
    await axi.ok(["app", "install", apk, "--clean-data"]);
    await axi.ok(["app", "start", PKG]);
    await axi.ok(["app", "start", `${PKG}/.UiActivity`]);
    const [main] = await axi.pidsOf(PKG);
    const [ui] = await axi.pidsOf(`${PKG}:ui`);
    expect(main).toEqual(expect.any(Number));
    expect(ui).toEqual(expect.any(Number));
    return { main: main ?? 0, ui: ui ?? 0 };
  }

  test("nothing running, no task, a task the app removed itself: no-op or TASK_NOT_IN_RECENTS", async () => {
    await axi.ok(["app", "install", DEBUG_APK, "--clean-data"]);
    for (const format of ["json", "toon"] as const) {
      const args = ["app", "kill", PKG];
      const kill =
        format === "json" ? sharedWithToon(await axi.ok(args)) : (await axi.text(args)).data;
      expect(kill).toEqual({ ok: `kill ${PKG} -> already not running (no-op)` });
    }
    expect(await axi.pidsOf(PKG)).toEqual([]);

    const restore = await axi.fails(["app", "restore", PKG], "TASK_NOT_IN_RECENTS");
    expect(restore).toEqual({
      error: `${PKG} has no task in recents, so there is nothing to restore`,
      code: "TASK_NOT_IN_RECENTS",
      help: [
        `Run \`adb-axi app start ${PKG} --device ${axi.serial}\` to start it fresh (its saved state is not restored)`,
      ],
    });
    expect(await axi.pidsOf(PKG)).toEqual([]);

    const pids: number[] = [];
    const gone = await axi.fails(["app", "kill", PKG], "TASK_NOT_IN_RECENTS", {
      varies: ["kill"],
      before: async () => {
        await axi.ok(["app", "start", PKG]);
        await axi.mark("remove");
        await axi.probe("finishremove");
        const pid = Number(probeState(await axi.waitLog("event=finishremove ", "remove")).pid);
        pids.push(pid);
        await axi.waitFocused((component) => !component.startsWith(`${PKG}/`));
        expect(await axi.pidsOf(PKG)).toEqual([pid]);
      },
    });
    expect(gone).toMatchObject({
      error: `${PKG} was killed but its task is not in recents, so a restore would be a fresh launch`,
      kill: { pid_before: pids[0], pid_after: null, backgrounded_first: false },
      help: [`Run \`adb-axi app start ${PKG} --device ${axi.serial}\` to start it fresh`],
    });
    expect(await axi.pidsOf(PKG)).toEqual([]);
  });

  /**
   * `am kill` may end both processes, leave the `:ui` one for a run-as fallback (debuggable
   * builds), or leave it alive; whatever happened, adb-axi's answer must match the kernel.
   */
  async function truthfulKill(apk: string, debuggable: boolean): Promise<void> {
    const { main, ui } = await twoProcesses(apk);
    const run = await axi.run(["app", "kill", PKG, "--timeout", "5s"]);
    const alive = [...(await axi.pidsOf(PKG)), ...(await axi.pidsOf(`${PKG}:ui`))];
    if (run.exitCode === 0) {
      expect(run.json).toMatchObject({
        ok: `kill ${PKG} -> process gone, task kept in recents`,
        kill: { pid_before: `${main} ${ui}`, pid_after: null },
      });
      const method = (run.json.kill as { method: string }).method;
      expect(debuggable ? ["am kill", "run-as kill"] : ["am kill"]).toContain(method);
      expect(alive).toEqual([]);
      const restored = await axi.ok(["app", "restore", PKG]);
      expect(restored.app).toMatchObject({ activity: ".UiActivity", new_process: true });
      await axi.waitFocused((component) => component === `${PKG}/.UiActivity`);
    } else {
      expect(run.exitCode).toBe(1);
      expect(run.json).toMatchObject({
        error: expect.stringMatching(
          new RegExp(
            `^${PKG.replace(".", "\\.")} was still alive at the 5 s deadline after am kill`,
          ),
        ) as string,
        code: "KILL_TIMEOUT",
        last: { pid: ui },
        am_kill_sent: true,
      });
      expect(run.durationMs).toBeLessThan(5_000 + 2_000);
      expect(alive).toEqual([ui]);
    }
    await axi.ok(["app", "stop", PKG]);
    expect([...(await axi.pidsOf(PKG)), ...(await axi.pidsOf(`${PKG}:ui`))]).toEqual([]);
  }

  test("a second process: kill never claims success while one survives, debug or release", async () => {
    await truthfulKill(DEBUG_APK, true);
    await truthfulKill(RELEASE_APK, false);
  });

  test("restore of a running app keeps its process, and death of a stopped app only restores it", async () => {
    await axi.ok(["app", "install", DEBUG_APK, "--clean-data"]);
    const started = await axi.ok(["app", "start", PKG]);
    const pid = (started.app as { pid: number }).pid;
    await axi.sh("input keyevent KEYCODE_HOME");
    await axi.waitFocused((component) => !component.startsWith(`${PKG}/`));
    const restore = await axi.ok(["app", "restore", PKG]);
    expect(["hot", "unknown"]).toContain((restore.app as { launch: string }).launch);
    expect(sharedWithToon(restore)).toEqual({
      ok: `restore ${PKG} -> foreground from recents (same process)`,
      app: {
        activity: ".MainActivity",
        pid,
        launch: expect.any(String) as string,
        new_process: false,
      },
      help: [
        `Run \`adb-axi app kill ${PKG} --device ${axi.serial}\` first so the restore starts a new process`,
      ],
    });
    await axi.waitFocused((component) => component === `${PKG}/.MainActivity`);
    expect(await axi.pidsOf(PKG)).toEqual([pid]);

    await axi.ok(["app", "stop", PKG]);
    const death = (await axi.text(["app", "death", PKG])).data;
    const [restored] = await axi.pidsOf(PKG);
    expect(death).toMatchObject({
      ok: `death ${PKG} -> restored from recents (it was not running)`,
      death: {
        pid_before: null,
        pid_after_kill: null,
        pid_restored: restored,
        new_process: true,
        method: null,
      },
    });
    await axi.waitFocused((component) => component === `${PKG}/.MainActivity`);
  });

  test("death --compare without agent-device runs the kill and restore, then says the comparison is unavailable", async () => {
    const path = (process.env.PATH ?? "").split(delimiter);
    expect(path.filter((dir) => existsSync(join(dir, "agent-device")))).toEqual([]);
    await axi.ok(["app", "install", DEBUG_APK, "--clean-data"]);
    const started = await axi.ok(["app", "start", PKG]);
    const run = await axi.run(["app", "death", PKG, "--compare"]);
    expect(run.exitCode).toBe(1);
    const [restored] = await axi.pidsOf(PKG);
    expect(run.json).toMatchObject({
      error: `${PKG} was killed and restored, but the visible-text comparison could not run: agent-device is not installed or not on PATH`,
      code: "COMPARE_UNAVAILABLE",
      death: {
        pid_before: (started.app as { pid: number }).pid,
        pid_after_kill: null,
        pid_restored: restored,
        new_process: true,
      },
      help: [
        `Run \`adb-axi app death ${PKG} --device ${axi.serial}\` to repeat the check without --compare`,
      ],
    });
    await axi.waitFocused((component) => component === `${PKG}/.MainActivity`);
  });
});
