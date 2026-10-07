import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import process from "node:process";
import { URL } from "node:url";
import { deviceState } from "./success.js";

// Exercise the actual subprocess bridge, including its transport and audit boundary.
function bridge(state, args, configured = "emulator-5554") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-test-"));
  try {
    const adb = path.join(dir, "adb");
    fs.writeFileSync(
      adb,
      `#!/bin/sh
if [ "$1" = devices ]; then
  [ '${state}' != listing-error ] || exit 1
  [ '${state}' != malformed-listing ] || exit 0
  printf 'List of devices attached\\n'
  [ '${state}' = missing ] || printf 'emulator-5554\\t${state === "foreign" ? "device" : state}\\n'
  exit 0
fi
if [ "$3" = emu ]; then
  echo '${state === "foreign" ? "unowned" : "phone"}'
  exit 0
fi
if [ "$3" = get-state ]; then
  if [ '${state}' = missing ]; then echo "error: device '$2' not found" >&2; exit 1; fi
  if [ '${state}' = offline ]; then echo "error: device '$2' offline" >&2; exit 1; fi
  echo device; exit 0
fi
echo unexpected-operation >&2
exit 9
`,
      { mode: 0o755 },
    );
    const audit = path.join(dir, "audit.jsonl");
    const config = path.join(dir, "tools.json");
    fs.writeFileSync(
      config,
      JSON.stringify({
        bins: { adb },
        devices: [{ name: "phone", serial: configured }],
        audit,
        condition: "baseline",
        task: "8",
      }),
    );
    const result = spawnSync(
      process.execPath,
      [new URL("./tool-bridge.js", import.meta.url).pathname, "adb", ...args],
      {
        encoding: "utf8",
        env: { ...process.env, BENCH_TOOLS: config, ANDROID_SERIAL: "emulator-5554" },
      },
    );
    const calls = fs.existsSync(audit)
      ? fs.readFileSync(audit, "utf8").trim().split("\n").map(JSON.parse)
      : [];
    return { ...result, calls };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
test("owned stopped and offline get-state retains actual transport evidence and status", () => {
  for (const state of ["missing", "offline"]) {
    for (const args of [["-s", "emulator-5554", "get-state"], ["get-state"]]) {
      const result = bridge(state, args);
      assert.equal(result.status, 1);
      assert.equal(result.calls.length, 1);
      assert.equal(result.calls[0].status, 1);
      assert.equal(result.calls[0].stderr, result.stderr);
      assert.equal(deviceState(result.calls[0], "emulator-5554", "phone"), state);
    }
  }
});
test("attached owned get-state still executes and audits", () => {
  const result = bridge("device", ["-s", "emulator-5554", "get-state"]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "device\n");
  assert.equal(result.calls.length, 1);
});
test("unavailable access cannot authorize arbitrary serials, mutations or reused online targets", () => {
  for (const [state, args, configured] of [
    ["missing", ["-s", "emulator-5556", "get-state"]],
    ["missing", ["-s", "emulator-5554", "shell", "id"]],
    ["missing", ["-s", "emulator-5554", "get-state", "shell", "id"]],
    ["missing", ["-s", "emulator-5554", "kill-server"]],
    ["foreign", ["-s", "emulator-5554", "get-state"]],
    ["listing-error", ["-s", "emulator-5554", "get-state"]],
    ["malformed-listing", ["-s", "emulator-5554", "get-state"]],
    ["missing", ["-s", "physical-phone", "get-state"], "physical-phone"],
  ]) {
    const result = bridge(state, args, configured);
    assert.equal(result.status, 2);
    assert.equal(result.calls.length, 0);
  }
});
