import assert from "node:assert/strict";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  aggregate,
  parseTask,
  plan,
  root,
  skillEvidence,
  tasks,
  verifyPath,
  writeRecord,
} from "./core.js";
import { parsePi } from "./pi.js";
import { environment } from "./run.js";

function temporary(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "benchmark-test-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
test("eight neutral task definitions point to executable success checks", () => {
  assert.equal(tasks().length, 8);
  for (const t of tasks()) assert.ok(fs.existsSync(t.success));
  assert.throws(() => parseTask("{}"));
  assert.throws(() => parseTask(JSON.stringify({ ...tasks()[0], setup: "unknown" })));
  assert.throws(() => parseTask(JSON.stringify({ ...tasks()[0], prompt: "Use adb-axi" })));
});
test("dry-run guard, explicit spend authorization and hard cap", () => {
  assert.equal(plan([]).run, false);
  assert.equal(plan([]).runs, 16);
  assert.throws(() => plan(["--run"]));
  assert.throws(() => plan(["--run", "--tasks", "1", "--version", "0.1.2"]));
  assert.throws(() => plan(["--tasks", "9"]));
  assert.throws(() => plan(["--repeats", "0"]));
  assert.throws(() => plan(["--repeats", "5", "--max-runs", "79"]));
  assert.throws(() => plan(["--phone", "small_phone"]));
  assert.throws(() => plan(["--tablet", "Pixel_10_Pro_XL_Sasha"]));
  assert.equal(plan(["--run", "--tasks", "1", "--repeats", "1", "--version", "0.1.2"]).runs, 2);
});
test("records are exclusive, aggregation counts failures and missing metrics", () =>
  temporary((dir) => {
    const r = {
      id: "one",
      task: "1",
      condition: "baseline",
      success: true,
      inputTokens: 50,
      cost: 0.1,
      turns: 3,
      wallTimeMs: 100,
    };
    const file = writeRecord(dir, r);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), r);
    assert.throws(() => writeRecord(dir, r));
    const g = aggregate([r, { ...r, success: false }])[0];
    assert.equal(g.successRate, 0.5);
    assert.equal(g.turns, 6);
    assert.equal(g.cost, 0.2);
    assert.equal(aggregate([{ task: "1", condition: "baseline" }])[0].missingMetrics, 4);
  }));
test("PATH verification detects contamination inside exact environment", () =>
  temporary((dir) => {
    assert.equal(verifyPath({ PATH: dir }, "baseline").status, 1);
    fs.writeFileSync(path.join(dir, "adb-axi"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    assert.throws(() => verifyPath({ PATH: dir }, "baseline"));
    assert.equal(verifyPath({ PATH: dir }, "adb-axi").resolved, path.join(dir, "adb-axi"));
  }));
test("skill evidence comes from actual isolated files including supporting references", () =>
  temporary((dir) => {
    fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: example\ndescription: Example\n---\n");
    assert.equal(skillEvidence(dir, "baseline")[0].name, "example");
    fs.writeFileSync(path.join(dir, "reference.md"), "use adb-axi");
    assert.throws(() => skillEvidence(dir, "baseline"));
  }));
test("both default conditions have exactly their declared isolated skills", () =>
  temporary((dir) => {
    const bins = { node: "/usr/bin/node" };
    for (const condition of ["baseline", "adb-axi"]) {
      const e = environment(path.join(dir, condition), condition, "0.1.2", bins, [
        { name: "owned", serial: "emulator-5554" },
      ]);
      assert.deepEqual(
        e.skills.map((s) => s.name).sort(),
        condition === "baseline" ? ["android-cli"] : ["adb-axi", "android-cli"],
      );
      assert.ok(!e.env.PATH.includes(".local/bin"));
    }
  }));
test("Pi event parser captures all assistant turns, cached input, cost and final answer", () => {
  const message = {
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    stopReason: "stop",
    usage: { input: 100, cacheRead: 20, cacheWrite: 5, cost: { total: 0.01 } },
  };
  const parsed = parsePi(
    [
      JSON.stringify({ type: "message_update" }),
      JSON.stringify({ type: "message_end", message }),
      JSON.stringify({ type: "message_end", message }),
    ].join("\n"),
  );
  assert.equal(parsed.inputTokens, 250);
  assert.equal(parsed.cost, 0.02);
  assert.equal(parsed.turns, 2);
  assert.equal(parsed.finalAnswer, "done");
  assert.throws(() => parsePi("{}"));
});

test("device bridge filters tab and space-separated listings and refuses foreign targets", () =>
  temporary((dir) => {
    const fakeAdb = path.join(dir, "adb");
    fs.writeFileSync(
      fakeAdb,
      '#!/bin/sh\necho "List of devices attached"\necho "emulator-5554 device product:phone"\nprintf "emulator-5556\\tdevice\\n"\necho "physical-serial device"\n',
      { mode: 0o755 },
    );
    const config = path.join(dir, "tools.json");
    fs.writeFileSync(
      config,
      JSON.stringify({
        bins: { adb: fakeAdb },
        devices: [
          { serial: "emulator-5554", name: "phone" },
          { serial: "emulator-5556", name: "tablet" },
        ],
        audit: path.join(dir, "audit.jsonl"),
        condition: "baseline",
      }),
    );
    const invoke = (args) =>
      spawnSync(process.execPath, [path.join(root, "bench/tool-bridge.js"), ...args], {
        env: { BENCH_TOOLS: config },
        encoding: "utf8",
      });
    const listing = invoke(["adb", "devices", "-l"]);
    assert.equal(listing.status, 0);
    assert.match(listing.stdout, /emulator-5554/);
    assert.match(listing.stdout, /emulator-5556/);
    assert.doesNotMatch(listing.stdout, /physical-serial/);
    assert.equal(invoke(["adb", "-s", "physical-serial", "shell", "id"]).status, 2);
    assert.equal(invoke(["android", "layout", "--device=physical-serial"]).status, 2);
    assert.equal(invoke(["android", "emulator", "stop", "small_phone"]).status, 2);
    assert.equal(invoke(["npx", "-y", "adb-axi"]).status, 2);
  }));

test("dry-run entry point succeeds without any tools on PATH and rejects incomplete authorization", () => {
  const invoke = (args) =>
    spawnSync(process.execPath, [path.join(root, "bench/run.js"), ...args], {
      env: { PATH: "" },
      encoding: "utf8",
    });
  const dry = invoke(["--tasks", "1", "--repeats", "1"]);
  assert.equal(dry.status, 0);
  assert.equal(JSON.parse(dry.stdout).runs, 2);
  assert.equal(invoke(["--run", "--tasks", "1"]).status, 1);
});
test("success scripts reject incorrect reports even when device evidence succeeds", async () =>
  temporary((dir) => {
    const phone = { name: "phone", serial: "emulator-5554" };
    const devices = {
      owned: [phone],
      adb: () =>
        "event=inc saved=3 volatile=3 rows=0 restored=false pid=100\nevent=start saved=3 volatile=0 rows=0 restored=true pid=200\njava.lang.IllegalStateException: probe crash requested",
      shell: () => "mResumedActivity dev.probe/.MainActivity",
    };
    const audit = path.join(dir, "absent");
    return import("./success.js").then(({ checkTask }) => {
      const good = {
        before: { saved: 3, unsaved: 3 },
        after: { saved: 3, unsaved: 0 },
        savedSurvived: true,
        unsavedReset: true,
      };
      assert.equal(
        checkTask("2", { devices, audit, finalAnswer: JSON.stringify(good) }).success,
        true,
      );
      assert.equal(
        checkTask("2", {
          devices,
          audit,
          finalAnswer: JSON.stringify({ ...good, after: { saved: 0, unsaved: 0 } }),
        }).success,
        false,
      );
      assert.equal(
        checkTask("3", {
          devices,
          audit,
          finalAnswer: JSON.stringify({
            exception: "IllegalStateException",
            message: "probe crash requested",
          }),
        }).success,
        true,
      );
      assert.equal(
        checkTask("3", {
          devices,
          audit,
          finalAnswer: "It was not IllegalStateException: probe crash requested",
        }).success,
        false,
      );
    });
  }));
