import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Axi, DEBUG_APK, PKG } from "./support.js";

const axi = new Axi(import.meta.filename);

/** Bounds each readiness poll; a second user is unlocked and in front within 20 s locally. */
const READY_MS = 120_000;

let user: number | undefined;
let probeAppId: number;

async function until(what: string, check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + READY_MS;
  while (!(await check())) {
    expect(Date.now(), `still waiting for ${what}`).toBeLessThan(deadline);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** Ground truth from raw adb: `adb-axi shell` shows only the first 50 lines of a long dump. */
async function raw(command: string): Promise<string> {
  const run = await axi.adb(["shell", command]);
  expect(run.exitCode, command).toBe(0);
  return run.stdout.replaceAll("\r", "");
}

async function appIdOf(pkg: string): Promise<number> {
  const id = /^\s*(?:appId|userId)=(\d+)\s*$/m.exec(await raw(`dumpsys package ${pkg}`))?.[1];
  expect(id, `app id of ${pkg}`).toBeDefined();
  return Number(id);
}

/** Pids by kernel uid, as `ps` lists them, for the processes named `name`. */
async function pidsUnder(uid: number, name: string): Promise<number[]> {
  return (await raw("ps -A -o PID,UID,NAME"))
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter(([, rowUid, rowName]) => Number(rowUid) === uid && rowName === name)
    .map(([pid]) => Number(pid));
}

async function pidof(name: string): Promise<number[]> {
  const out = (await axi.sh(`pidof ${name} || true`)).trim();
  return out === "" ? [] : out.split(/\s+/).map(Number);
}

/** The resumed activity of user `n`, as `dumpsys activity activities` names it. */
async function resumedOf(n: number): Promise<string | undefined> {
  const dump = await raw("dumpsys activity activities");
  return new RegExp(`ResumedActivity[:=]\\s*ActivityRecord\\{\\S+ u${n} (\\S+)/`).exec(dump)?.[1];
}

function uidOf(userId: number, appId: number): number {
  return userId * 100000 + appId;
}

beforeAll(async () => {
  // Ids are not reused, so the new user's id is read from the output.
  const created = await axi.sh("pm create-user adb-axi-second");
  const id = /Success: created user id (\d+)/.exec(created)?.[1];
  expect(id, created).toBeDefined();
  user = Number(id);
  const n = user;
  // A fresh install covers every existing user; a reinstall keeps the old per-user state.
  await axi.adb(["uninstall", PKG]);
  expect((await axi.adb(["install", "-t", DEBUG_APK])).exitCode).toBe(0);
  expect(await axi.sh(`pm list packages --user ${n} ${PKG}`)).toContain(`package:${PKG}`);
  probeAppId = await appIdOf(PKG);
  await axi.sh(`am start --user 0 -W -n ${PKG}/.MainActivity`);
  await axi.sh(`am start --user 0 -W -n ${PKG}/.UiActivity`);
  await axi.sh(`am switch-user ${n}`);
  await until(`user ${n} to unlock`, async () =>
    (await axi.sh(`am get-started-user-state ${n}`)).includes("RUNNING_UNLOCKED"),
  );
  // Without this, API 29's keyguard held the new user's launcher back for minutes.
  await axi.sh("wm dismiss-keyguard");
  await until(`an activity of user ${n} in front`, async () => (await resumedOf(n)) !== undefined);
}, 300_000);

afterAll(async () => {
  if (user === undefined) return;
  const n = user;
  await axi.sh("am switch-user 0");
  await until(
    "user 0 in front again",
    async () => (await axi.sh("am get-current-user")).trim() === "0",
  );
  // Removing a user that is still running failed on API 35.
  await axi.sh(`am stop-user -w ${n}`);
  expect(await axi.sh(`pm remove-user ${n}`)).toContain("Success: removed user");
}, 300_000);

describe("a second Android user in front, with the probe running only for user 0", () => {
  test("process reads follow the current user's processes, not the owner's", async () => {
    const n = user ?? 0;
    const owner = uidOf(0, probeAppId);
    const current = uidOf(n, probeAppId);
    expect(await pidsUnder(owner, PKG)).toHaveLength(1);
    expect(await pidsUnder(owner, `${PKG}:ui`)).toHaveLength(1);
    expect(await pidsUnder(current, PKG)).toEqual([]);
    expect(await pidsUnder(current, `${PKG}:ui`)).toEqual([]);

    expect((await axi.ok(["app", "info", PKG])).app).toMatchObject({ installed: true, pid: "-" });

    const running = await axi.run(["wait", "app", PKG, "--state", "running", "--timeout", "3s"]);
    expect(running.exitCode).toBe(1);
    expect(running.json).toMatchObject({
      code: "WAIT_TIMEOUT",
      last: { state: "stopped", pid: "-" },
    });
    expect((await axi.ok(["wait", "app", PKG, "--state", "stopped"])).ok).toMatch(
      new RegExp(`^wait app ${PKG} -> stopped after \\d+ ms$`),
    );

    const resumed = await resumedOf(n);
    expect(resumed).toBeDefined();
    const front = resumed ?? "";
    const frontPids = await pidsUnder(uidOf(n, await appIdOf(front)), front);
    expect(frontPids).toHaveLength(1);
    expect((await axi.ok(["app", "current"])).app).toMatchObject({
      package: front,
      pid: frontPids[0],
    });
  });
});

describe("the probe started for the second user too", () => {
  test("app info reads the current user's processes", async () => {
    const n = user ?? 0;
    const owner = uidOf(0, probeAppId);
    const current = uidOf(n, probeAppId);
    await axi.sh(`am start --user ${n} -W -n ${PKG}/.MainActivity`);
    await axi.sh(`am start --user ${n} -W -n ${PKG}/.UiActivity`);
    const ownerPids = [...(await pidsUnder(owner, PKG)), ...(await pidsUnder(owner, `${PKG}:ui`))];
    const [main] = await pidsUnder(current, PKG);
    const [ui] = await pidsUnder(current, `${PKG}:ui`);
    expect(ownerPids).toHaveLength(2);
    expect(main).toBeDefined();
    expect(ui).toBeDefined();
    expect(await pidof(PKG)).toContain(main);

    expect((await axi.ok(["app", "info", PKG])).app).toMatchObject({ pid: main });
  });
});
