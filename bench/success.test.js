import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { URL } from "node:url";
import { test } from "node:test";
import { checkTask, deviceState } from "./success.js";

function score(fixture, calls = fixture.calls, answer = fixture.finalAnswer) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-test-"));
  try {
    const audit = path.join(dir, "audit.jsonl");
    fs.writeFileSync(audit, calls.map((c) => JSON.stringify(c)).join("\n"));
    const devices = {
      owned: fixture.devices.map((d) => ({ ...d, uiHolderPid: fixture.initialHolderPid })),
      current: () => true,
      adb: () => "",
      shell: () => "1",
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
      assert.equal(score(fixture).success, task !== "8" || condition !== "baseline");
    });
    test(`pilot task ${task} ${condition}: fabricated or incomplete outcome fails`, () => {
      if (task === "6") {
        for (const holder of [
          "unknown",
          "com.unrelated.instrumentation",
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
const base = {
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
test("inferred lifecycle requires an online/unavailable/online sequence", () => {
  const online = {
    time: 1,
    tool: "other",
    args: [],
    status: 0,
    stdout: "devices[1]{serial,state}:\n  emulator-5554,device\n",
  };
  const missing = { ...online, time: 2, stdout: '{"devices":[]}' };
  const recovered = { ...online, time: 3 };
  assert.equal(score(base, [online, missing, recovered]).success, true);
  assert.equal(score(base, [missing, recovered]).success, false);
  assert.equal(score(base, [online, missing]).success, false);
  assert.equal(score(base, [recovered, { ...missing, time: 4 }]).success, false);
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
