import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { URL } from "node:url";
import { test } from "node:test";
import { checkTask, deviceState, setupTask } from "./success.js";

const beforeBoot = "12345678-1234-1234-1234-123456789abc";
const afterBoot = "abcdef01-1234-1234-1234-123456789abc";
function score(
  fixture,
  calls = fixture.calls,
  answer = fixture.finalAnswer,
  finalBoot = afterBoot,
  finalPid = "202",
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-test-"));
  try {
    const audit = path.join(dir, "audit.jsonl");
    fs.writeFileSync(audit, calls.map((c) => JSON.stringify(c)).join("\n"));
    const devices = {
      owned: fixture.devices.map((d) => ({
        ...d,
        uiHolderPid: fixture.initialHolderPid,
        task8BootId: fixture.task8BootId,
        task8EmulatorPid: fixture.task8EmulatorPid,
      })),
      current: () => true,
      emulatorPid: () => finalPid,
      adb: () => "",
      shell: (_d, text) => (text.includes("boot_id") ? finalBoot : "1"),
    };
    return checkTask(fixture.task, { devices, audit, finalAnswer: answer });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
for (const task of ["6", "8"]) {
  for (const condition of ["baseline", "adb-axi"]) {
    const fixture = JSON.parse(
      fs.readFileSync(new URL(`./fixtures/pilot/${task}-${condition}.json`, import.meta.url)),
    );
    test(`pilot task ${task} ${condition}: evidence-backed historical score`, () => {
      assert.equal(score(fixture).success, task !== "8");
    });
    test(`pilot task ${task} ${condition}: fabricated or incomplete outcome fails`, () => {
      if (task === "6") {
        for (const holder of [
          "unknown",
          "com.unrelated.instrumentation",
          "com.unrelated.instrumentation (not com.android.cli.interact.instrumentation)",
          "COM.ANDROID.CLI.INTERACT.INSTRUMENTATION",
          42,
        ]) {
          assert.equal(
            score(fixture, fixture.calls, JSON.stringify({ holder, layoutWorks: true })).success,
            false,
          );
        }
        assert.equal(
          score(
            fixture,
            fixture.calls.filter((c) => c.tool !== "ui-holder-oracle"),
          ).success,
          false,
        );
      } else {
        assert.equal(
          score(
            fixture,
            fixture.calls.filter(
              (c) =>
                deviceState(c, fixture.devices[0].serial, fixture.devices[0].name) === "online",
            ),
          ).success,
          false,
        );
        assert.equal(
          score(
            fixture,
            fixture.calls.filter(
              (c) =>
                deviceState(c, fixture.devices[0].serial, fixture.devices[0].name) !== "offline",
            ),
            JSON.stringify({ unavailableState: "offline", recovered: true }),
          ).success,
          false,
        );
      }
    });
  }
}
test("holder reports accept class and descriptive identity but reject contradictory packages", () => {
  const fixture = JSON.parse(
    fs.readFileSync(new URL("./fixtures/pilot/6-adb-axi.json", import.meta.url)),
  );
  for (const holder of [
    "com.android.cli.interact.instrumentation/com.android.cli.interact.instrumentation.InstrumentationServer",
    "UI holder: com.android.cli.interact.instrumentation (Android CLI)",
  ])
    assert.equal(
      score(fixture, fixture.calls, JSON.stringify({ holder, layoutWorks: true })).success,
      true,
    );
  for (const holder of [
    "com.unrelated.instrumentation (not com.android.cli.interact.instrumentation)",
    "com.android.cli.interact.instrumentation and com.unrelated.instrumentation",
    "not com.android.cli.interact.instrumentation",
  ])
    assert.equal(
      score(fixture, fixture.calls, JSON.stringify({ holder, layoutWorks: true })).success,
      false,
    );
});
test("historical treatment observation needs independently captured host and boot identities", () => {
  const fixture = JSON.parse(
    fs.readFileSync(new URL("./fixtures/pilot/8-adb-axi.json", import.meta.url)),
  );
  assert.equal(score(fixture).success, false);
  const captured = { ...fixture, task8BootId: beforeBoot, task8EmulatorPid: "101" };
  assert.equal(score(captured).success, true);
  assert.equal(score(captured, fixture.calls, fixture.finalAnswer, beforeBoot).success, false);
  assert.equal(
    score(captured, fixture.calls, fixture.finalAnswer, afterBoot, "101").success,
    false,
  );
});
test("task 8 setup captures and validates the owned phone boot identity", () => {
  const phone = { name: "phone", serial: "emulator-5554" };
  const devices = {
    owned: [phone],
    reset: () => {},
    shell: () => beforeBoot,
    emulatorPid: () => "101",
  };
  setupTask({ id: "8", setup: "clean" }, devices);
  assert.equal(phone.task8BootId, beforeBoot);
  assert.equal(phone.task8EmulatorPid, "101");
  devices.shell = () => "not-a-boot-id";
  assert.throws(
    () => setupTask({ id: "8", setup: "clean" }, devices),
    /Invalid initial phone boot ID/,
  );
});
const base = {
  task8BootId: beforeBoot,
  task8EmulatorPid: "101",
  task: "8",
  devices: [{ name: "phone", serial: "emulator-5554" }],
  finalAnswer: JSON.stringify({ unavailableState: "missing", recovered: true }),
};
const stop = { time: 1, tool: "android", args: ["emulator", "stop", "phone"], status: 0 };
const restart = { time: 3, tool: "android", args: ["emulator", "start", "phone"], status: 0 };
test("unavailable observation is tool-neutral and report must match evidence", () => {
  for (const tool of ["adb", "adb-axi", "android", "other-tool"]) {
    for (const [state, stdout, status] of [
      ["missing", "List of devices attached\n", 0],
      ["missing", JSON.stringify({ devices: [] }), 0],
      ["missing", "devices[1]{serial,avd,state}:\n  emulator-5556,tablet,device\n", 0],
      ["offline", "error: emulator-5554 offline", 1],
      ["unavailable", "phone unavailable", 1],
    ]) {
      const calls = [stop, { time: 2, tool, args: [], stdout, status }, restart];
      assert.equal(
        score(base, calls, JSON.stringify({ unavailableState: state, recovered: true })).success,
        true,
      );
      assert.equal(
        score(base, calls, JSON.stringify({ unavailableState: "unavailable", recovered: true }))
          .success,
        true,
      );
      assert.equal(
        score(
          base,
          calls,
          JSON.stringify({
            unavailableState: state === "offline" ? "missing" : "offline",
            recovered: true,
          }),
        ).success,
        false,
      );
    }
  }
});
test("targeted wait boot timeouts count as unavailable observations in JSON and TOON", () => {
  for (const target of ["phone", "emulator-5554"]) {
    for (const [state, report] of [
      ["not attached", "missing"],
      ["offline", "offline"],
    ]) {
      for (const [flag, suffix] of [
        ["--device", "--json"],
        ["-s", ""],
      ]) {
        const result = suffix
          ? JSON.stringify({ error: `wait boot ${target} timed out`, last: { state } })
          : `error: "wait boot ${target} timed out"\nlast:\n  state: "${state}"\n`;
        const call = {
          time: 2,
          tool: "adb-axi",
          args: ["wait", "boot", flag, target, "--timeout", "500ms", ...(suffix ? [suffix] : [])],
          status: 1,
          stdout: result,
        };
        const answer = JSON.stringify({ unavailableState: report, recovered: true });
        assert.equal(score(base, [stop, call, restart], answer).success, true);
        assert.equal(
          score(
            base,
            [stop, call, restart],
            JSON.stringify({
              unavailableState: report === "missing" ? "offline" : "missing",
              recovered: true,
            }),
          ).success,
          false,
        );
        for (const invalid of [
          { ...call, args: ["wait", "boot", flag, "tablet", "--timeout", "500ms"] },
          { ...call, stdout: result.replace(target, "tablet") },
          { ...call, stdout: result.replace(/timed out/, "waiting") },
          { ...call, args: ["wait", "boot", "--timeout", "500ms"] },
        ])
          assert.equal(score(base, [stop, invalid, restart], answer).success, false);
      }
    }
  }
  const toon = {
    time: 2,
    tool: "adb-axi",
    args: ["wait", "boot", "--device=phone"],
    status: 1,
    stderr: 'error: "wait boot phone timed out"\nlast.state: "not attached"\n',
  };
  assert.equal(score(base, [stop, toon, restart]).success, true);
});
test("actual targeted WAIT_TIMEOUT output scores JSON and TOON unavailable states", () => {
  for (const target of ["phone", "emulator-5554"]) {
    for (const [state, report] of [
      ["not attached", "missing"],
      ["offline", "offline"],
    ]) {
      for (const format of ["json", "toon"]) {
        const result =
          format === "json"
            ? JSON.stringify({
                error: `${target} had not finished booting after 500 ms`,
                code: "WAIT_TIMEOUT",
                last: { state, boot_completed: "unknown" },
              })
            : `error: ${target} had not finished booting after 500 ms\ncode: WAIT_TIMEOUT\nlast:\n  state: ${state}\n  boot_completed: unknown\n`;
        const call = {
          time: 2,
          tool: "adb-axi",
          args: [
            "wait",
            "boot",
            "-s",
            target,
            "--timeout",
            "500ms",
            ...(format === "json" ? ["--json"] : []),
          ],
          status: 1,
          [format === "json" ? "stdout" : "stderr"]: result,
        };
        const answer = JSON.stringify({ unavailableState: report, recovered: true });
        assert.equal(score(base, [stop, call, restart], answer).success, true);
        for (const invalid of [
          { ...call, args: ["wait", "boot", "-s", "tablet", "--timeout", "500ms"] },
          { ...call, [format === "json" ? "stdout" : "stderr"]: result.replace(target, "tablet") },
          {
            ...call,
            [format === "json" ? "stdout" : "stderr"]: result.replace(
              "WAIT_TIMEOUT",
              "OTHER_ERROR",
            ),
          },
          { ...call, args: ["wait", "boot", "--timeout", "500ms"] },
        ])
          assert.equal(score(base, [stop, invalid, restart], answer).success, false);
      }
    }
  }
});
test("visible missing listing and raw offline output demand their respective reports", () => {
  const listing = {
    time: 2,
    tool: "adb",
    args: ["devices", "-l"],
    status: 0,
    stdout: "List of devices attached\n",
  };
  const offline = { ...listing, stdout: "List of devices attached\nemulator-5554 offline\n" };
  assert.equal(score(base, [stop, listing, restart]).success, true);
  assert.equal(
    score(
      base,
      [stop, listing, restart],
      JSON.stringify({ unavailableState: "offline", recovered: true }),
    ).success,
    false,
  );
  assert.equal(
    score(
      base,
      [stop, offline, restart],
      JSON.stringify({ unavailableState: "offline", recovered: true }),
    ).success,
    true,
  );
  assert.equal(score(base, [stop, offline, restart]).success, false);
});
test("process and boot identities reject disconnect or reboot but accept a restarted emulator", () => {
  const online = {
    time: 1,
    tool: "other",
    args: [],
    status: 0,
    stdout: "devices[1]{serial,state}:\n  emulator-5554,device\n",
  };
  const missing = { ...online, time: 2, stdout: '{"devices":[]}' };
  const recovered = { ...online, time: 3 };
  assert.equal(
    score(base, [online, missing, recovered], base.finalAnswer, beforeBoot).success,
    false,
  );
  assert.equal(
    score(base, [online, missing, recovered], base.finalAnswer, afterBoot, "101").success,
    false,
  );
  assert.equal(score(base, [online, missing, recovered]).success, true);
  assert.equal(
    score(base, [online, missing, recovered], base.finalAnswer, "invalid").success,
    false,
  );
  assert.equal(score(base, [missing, recovered]).success, false);
  assert.equal(score(base, [online, missing]).success, false);
  assert.equal(score(base, [recovered, { ...missing, time: 4 }]).success, false);
});
test("later valid stop/observation/restart cycle counts", () => {
  const missing = {
    time: 5,
    tool: "adb",
    args: ["devices"],
    status: 0,
    stdout: "List of devices attached\n",
  };
  assert.equal(
    score(base, [stop, restart, { ...stop, time: 4 }, missing, { ...restart, time: 6 }]).success,
    true,
  );
  assert.equal(score(base, [stop, restart, missing]).success, false);
});
test("stop/start without observation, help, wrong target, and out-of-window output fail", () => {
  const missing = { time: 2, tool: "adb-axi", args: [], status: 0, stdout: '{"devices":[]}' };
  for (const calls of [
    [stop, restart],
    [{ ...stop, args: ["emulator", "stop", "--help", "phone"] }, missing, restart],
    [stop, missing, { ...restart, args: ["emulator", "start", "--help", "phone"] }],
    [stop, { ...missing, stdout: "error: tablet unavailable" }, restart],
    [stop, { ...missing, time: 4 }, restart],
    [{ ...missing, time: 0 }, stop, restart],
    [stop, { ...missing, stdout: "phone\ntablet\n" }, restart],
    [stop, { ...missing, stdout: "" }, restart],
  ])
    assert.equal(score(base, calls).success, false);
});
