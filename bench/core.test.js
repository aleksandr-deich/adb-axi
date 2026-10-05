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
import { parsePi, runPi } from "./pi.js";
import { checkTask } from "./success.js";
import { Devices, emulatorPid } from "./devices.js";
import { environment } from "./run.js";
import task8Reference from "./reference/8.js";
import "./success.test.js";

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
  for (const t of tasks()) {
    assert.ok(fs.existsSync(t.success));
    assert.ok(fs.existsSync(t.reference));
  }
  assert.throws(() => parseTask("{}"));
  assert.throws(() => parseTask(JSON.stringify({ ...tasks()[0], setup: "unknown" })));
  assert.throws(() => parseTask(JSON.stringify({ ...tasks()[0], prompt: "Use adb-axi" })));
});
test("dry-run guard, explicit spend authorization and hard cap", () => {
  assert.equal(plan([]).run, false);
  assert.equal(plan([]).runs, 16);
  assert.deepEqual(plan([]).conditions, ["baseline", "adb-axi"]);
  assert.throws(() => plan(["--conditions", "baseline"]));
  assert.throws(() => plan(["--run"]));
  assert.throws(() => plan(["run", "--tasks", "1", "--repeats", "1", "--version", "0.1.2"]));
  assert.throws(() => plan(["--run", "tasks", "1", "repeats", "1", "version", "0.1.2"]));
  assert.throws(() => plan(["--run", "--tasks", "1", "--version", "0.1.2"]));
  assert.throws(() => plan(["--tasks", "9"]));
  assert.throws(() => plan(["--repeats", "0"]));
  assert.throws(() => plan(["--repeats", "5", "--max-runs", "79"]));
  assert.throws(() => plan(["--phone", "small_phone"]));
  assert.throws(() => plan(["--phone", "SMALL_PHONE"]));
  assert.throws(() => plan(["--tablet", "pixel_10_pro_xl_sasha"]));
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
    assert.notEqual(verifyPath({ PATH: dir }, "baseline").status, 0);
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

test("nonzero Pi exit retains completed metrics and output while remaining a failure", () =>
  temporary((dir) => {
    const fake = path.join(dir, "pi");
    const event = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        stopReason: "stop",
        usage: { input: 11, cacheRead: 2, cost: { total: 0.03 } },
      },
    });
    fs.writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' '${event}'\nexit 7\n`, { mode: 0o755 });
    const output = path.join(dir, "agent.jsonl");
    assert.throws(
      () =>
        runPi({
          binary: fake,
          env: { PATH: "/usr/bin:/bin" },
          cwd: dir,
          skills: [],
          prompt: "task",
          output,
        }),
      (error) => {
        assert.match(error.message, /pi .*:/);
        assert.deepEqual(
          {
            inputTokens: error.metrics.inputTokens,
            cost: error.metrics.cost,
            turns: error.metrics.turns,
          },
          { inputTokens: 13, cost: 0.03, turns: 1 },
        );
        return true;
      },
    );
    assert.equal(fs.readFileSync(output, "utf8"), event + "\n");
  }));

test("device bridge filters tab and space-separated listings and refuses foreign targets", () =>
  temporary((dir) => {
    const fakeAdb = path.join(dir, "adb");
    fs.writeFileSync(
      fakeAdb,
      '#!/bin/sh\ncase "$*" in\n  devices*) echo "List of devices attached"; echo "emulator-5554 device product:phone"; printf "emulator-5556\\tdevice\\n"; echo "physical-serial device";;\n  *"emulator-5554 emu avd name") echo phone;;\n  *"emulator-5556 emu avd name") echo tablet;;\n  *"physical-serial emu avd name") echo foreign;;\nesac\n',
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

test("bridge discovers and accepts only verified owned serials after restart", () =>
  temporary((dir) => {
    const fake = path.join(dir, "adb");
    const android = path.join(dir, "android");
    const active = path.join(dir, "active");
    fs.writeFileSync(active, "emulator-5554");
    fs.writeFileSync(
      fake,
      `#!/bin/sh\ncase "$*" in\n  devices) printf 'List of devices attached\\n%s\\tdevice\\nemulator-9998\\tdevice\\n' "$(/bin/cat '${active}')";;\n  *"emulator-9998 emu avd name") echo foreign;;\n  *"emu avd name") echo phone;;\n  *) echo ready;;\nesac\n`,
      { mode: 0o755 },
    );
    fs.writeFileSync(android, "#!/bin/sh\necho layout-ready\n", { mode: 0o755 });
    const config = path.join(dir, "tools.json");
    fs.writeFileSync(
      config,
      JSON.stringify({
        bins: { adb: fake, android },
        devices: [{ name: "phone", serial: "emulator-5554" }],
        audit: path.join(dir, "audit"),
        condition: "baseline",
      }),
    );
    const invoke = (...args) =>
      spawnSync(process.execPath, [path.join(root, "bench/tool-bridge.js"), ...args], {
        env: { BENCH_TOOLS: config },
        encoding: "utf8",
      });
    assert.match(invoke("adb", "devices").stdout, /emulator-5554/);
    fs.writeFileSync(active, "emulator-5580");
    const listing = invoke("adb", "devices");
    assert.equal(listing.status, 0);
    assert.match(listing.stdout, /emulator-5580/);
    assert.doesNotMatch(listing.stdout, /emulator-9998|emulator-5554/);
    assert.equal(invoke("adb", "-s", "emulator-5580", "shell", "id").status, 0);
    assert.equal(invoke("android", "layout", "--device=emulator-5580").status, 0);
    assert.equal(invoke("adb", "-s", "emulator-5554", "shell", "id").status, 2);
    assert.equal(invoke("adb", "-s", "emulator-9998", "shell", "id").status, 2);
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
  assert.deepEqual(JSON.parse(dry.stdout).conditions, ["baseline", "adb-axi"]);
  assert.equal(invoke(["--tasks", "1", "--conditions", "baseline"]).status, 1);
  assert.equal(invoke(["--run", "--tasks", "1"]).status, 1);
});
test("success scripts reject incorrect reports even when device evidence succeeds", async () =>
  temporary((dir) => {
    const phone = { name: "phone", serial: "emulator-5554" };
    const devices = {
      owned: [phone],
      adb: () =>
        "123.450 100 100 I ProbeState: event=inc saved=3 volatile=3 rows=0 restored=false pid=100\n123.451 200 200 I ProbeState: event=start saved=3 volatile=0 rows=0 restored=true pid=200\n123.456 100 100 E AndroidRuntime: Process: dev.probe, PID: 100\n123.457 100 100 E AndroidRuntime: java.lang.IllegalStateException: probe crash requested",
      shell: (d, text) =>
        text.startsWith("pidof") ? "200" : "mResumedActivity dev.probe/.MainActivity",
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

test("treatment's adb transport snapshots the debug database before shell uninstall", () =>
  temporary((dir) => {
    const database = path.join(dir, "probe.db");
    assert.equal(
      spawnSync("/usr/bin/sqlite3", [
        database,
        "CREATE TABLE notes(id INTEGER, text TEXT); INSERT INTO notes VALUES(1, 'probe-1');",
      ]).status,
      0,
    );
    const fake = path.join(dir, "adb");
    fs.writeFileSync(
      fake,
      `#!/bin/sh\ncase "$*" in\n  devices) printf 'List of devices attached\\nemulator-5554\\tdevice\\n';;\n  *"emu avd name") echo owned;;\n  *"run-as dev.probe cat databases/probe.db") exec /bin/cat '${database}';;\n  *"run-as dev.probe cat databases/probe.db-wal") exit 1;;\n  *"shell pm uninstall dev.probe") /bin/rm '${database}'; echo Success;;\nesac\n`,
      { mode: 0o755 },
    );
    const audit = path.join(dir, "audit.jsonl");
    const config = path.join(dir, "tools.json");
    fs.writeFileSync(
      config,
      JSON.stringify({
        bins: { adb: fake },
        devices: [{ serial: "emulator-5554", name: "owned" }],
        condition: "adb-axi",
        task: "4",
        audit,
      }),
    );
    const result = spawnSync(
      process.execPath,
      [
        path.join(root, "bench/tool-bridge.js"),
        "adb",
        "-s",
        "emulator-5554",
        "shell",
        "pm uninstall dev.probe",
      ],
      { env: { BENCH_TOOLS: config, TMPDIR: dir }, encoding: "utf8" },
    );
    assert.equal(result.status, 0);
    assert.equal(fs.existsSync(database), false);
    const calls = fs
      .readFileSync(audit, "utf8")
      .trim()
      .split("\n")
      .map((x) => JSON.parse(x));
    assert.equal(calls[0].tool, "database-oracle");
    assert.match(calls[0].stdout, /1\\|probe-1/);
  }));

test("bridge preserves binary exec-out bytes and drains large piped stdout", () =>
  temporary((dir) => {
    const fake = path.join(dir, "fake.mjs");
    fs.writeFileSync(
      fake,
      `#!${process.execPath}\nimport process from 'node:process';\nimport { Buffer } from 'node:buffer';\nif (process.argv[2] === 'devices') process.stdout.write('List of devices attached\\nemulator-5554\\tdevice\\n');\nelse if (process.argv.includes('emu')) process.stdout.write('owned\\n');\nelse { const b = Buffer.alloc(262144); for(let i=0;i<b.length;i++) b[i]=i%256; process.stdout.write(b); }\n`,
      { mode: 0o755 },
    );
    const config = path.join(dir, "tools.json");
    fs.writeFileSync(
      config,
      JSON.stringify({
        bins: { adb: fake },
        devices: [{ serial: "emulator-5554", name: "owned" }],
        condition: "baseline",
        audit: path.join(dir, "audit.jsonl"),
      }),
    );
    const r = spawnSync(
      process.execPath,
      [
        path.join(root, "bench/tool-bridge.js"),
        "adb",
        "-s",
        "emulator-5554",
        "exec-out",
        "payload",
      ],
      { env: { BENCH_TOOLS: config }, maxBuffer: 4194304 },
    );
    assert.equal(r.status, 0);
    assert.equal(r.stdout.length, 262144);
    for (let i = 0; i < r.stdout.length; i++) assert.equal(r.stdout[i], i % 256);
  }));
test("self-check help and spend rejection require neither devices nor Pi", () => {
  const invoke = (args) =>
    spawnSync(process.execPath, [path.join(root, "bench/run.js"), "self-check", ...args], {
      env: { PATH: "" },
      encoding: "utf8",
    });
  assert.equal(invoke(["--help"]).status, 0);
  const rejected = invoke(["--run", "--tasks", "1", "--repeats", "1", "--version", "0.1.2"]);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /never runs an agent/);
});

test("emulator identity uses the boot property when the console silently returns no bytes", () =>
  temporary((dir) => {
    const fake = path.join(dir, "adb");
    fs.writeFileSync(fake, '#!/bin/sh\nif [ "$3" = "shell" ]; then echo owned; fi\n', {
      mode: 0o755,
    });
    const d = new Devices({ adb: fake }, ["owned"]);
    const owned = { serial: "emulator-5554", name: "owned" };
    d.owned.push(owned);
    assert.equal(d.name(owned.serial), "owned");
    d.assert(owned);
    owned.name = "foreign";
    assert.throws(() => d.assert(owned));
  }));
test("release write oracle accepts retained debug data rather than requiring a destructive reinstall", () =>
  temporary((dir) => {
    const audit = path.join(dir, "audit");
    fs.writeFileSync(
      audit,
      [
        { tool: "database-oracle", args: [], status: 0, stdout: "1|probe-1\n" },
        { tool: "adb", args: [], status: 0, stdout: "probe-1\n" },
        { tool: "adb", args: [], status: 0, stdout: "run-as: package not debuggable" },
      ]
        .map((x) => JSON.stringify(x))
        .join("\n"),
    );
    const devices = {
      owned: [{}],
      adb: () =>
        "event=write saved=0 volatile=0 rows=1 restored=false pid=10\nevent=write saved=0 volatile=0 rows=2 restored=false pid=20",
      shell: (d, text) =>
        text.startsWith("pm path")
          ? "package:/base.apk"
          : text.startsWith("pidof")
            ? "20"
            : text.startsWith("run-as")
              ? "not debuggable"
              : "flags=[]",
    };
    assert.equal(
      checkTask("4", {
        devices,
        audit,
        finalAnswer: JSON.stringify({ rowText: "probe-1", releaseError: "not debuggable" }),
      }).success,
      true,
    );
  }));
test("UI clear oracle requires observed old-PID disappearance, not command spelling", () =>
  temporary((dir) => {
    const audit = path.join(dir, "audit");
    const devices = { owned: [{ uiHolderPid: "100" }], adb: () => "" };
    const report = JSON.stringify({
      holder: "com.android.cli.interact.instrumentation",
      layoutWorks: true,
    });
    const base = [
      {
        time: 1,
        tool: "adb",
        args: ["shell", "ps -A"],
        status: 0,
        stdout: "com.android.cli.interact.instrumentation",
      },
      {
        time: 20,
        tool: "android",
        args: ["layout"],
        status: 0,
        stdout: JSON.stringify([{ "window-title": "Probe", content: [{ text: "dev.probe" }] }]),
      },
    ];
    for (const [stdout, success] of [
      ["100", false],
      ["", true],
      ["200", true],
      ["error: transport failed", false],
    ]) {
      fs.writeFileSync(
        audit,
        [...base, { time: 10, tool: "ui-holder-oracle", args: [], status: 0, stdout }]
          .map((x) => JSON.stringify(x))
          .join("\n"),
      );
      assert.equal(checkTask("6", { devices, audit, finalAnswer: report }).success, success);
    }
  }));

test("recovery and scoring follow the verified AVD onto its new serial", () =>
  temporary((dir) => {
    const fake = path.join(dir, "adb");
    fs.writeFileSync(
      fake,
      '#!/bin/sh\ncase "$*" in\n  devices) printf "List of devices attached\\nemulator-5580\\tdevice\\n";;\n  *"emu avd name"*) echo owned;;\n  *"getprop sys.boot_completed"*) echo 1;;\n  *"cat /proc/sys/kernel/random/boot_id"*) echo abcdef01-1234-1234-1234-123456789abc;;\n  *"pm path android"*) echo package:android;;\n  *) echo "";;\nesac\n',
      { mode: 0o755 },
    );
    const d = new Devices({ adb: fake, android: "/nonexistent-android" }, ["owned"]);
    const phone = { name: "owned", serial: "emulator-5554", task8BootId: "12345678-1234-1234-1234-123456789abc", task8EmulatorPid: "101" };
    d.emulatorPid = () => "202";
    d.owned.push(phone);
    d.recover(phone);
    assert.equal(phone.serial, "emulator-5580");
    const audit = path.join(dir, "audit");
    fs.writeFileSync(
      audit,
      [
        { time: 1, tool: "android", args: ["emulator", "stop", "owned"], status: 0 },
        {
          time: 2,
          tool: "adb",
          args: ["devices"],
          status: 0,
          stdout: "List of devices attached\n",
        },
        { time: 3, tool: "android", args: ["emulator", "start", "owned"], status: 0 },
      ]
        .map((c) => JSON.stringify(c))
        .join("\n"),
    );
    phone.serial = "emulator-5554";
    const result = checkTask("8", {
      devices: d,
      audit,
      finalAnswer: JSON.stringify({ unavailableState: "missing", recovered: true }),
    });
    assert.equal(result.success, true);
    assert.equal(phone.serial, "emulator-5580");
    const auditCases = [
      [
        { time: 1, tool: "android", args: ["emulator", "stop", "tablet"], status: 0 },
        {
          time: 2,
          tool: "adb",
          args: ["devices"],
          status: 0,
          stdout: "List of devices attached\\nemulator-5554 device\\n",
        },
        { time: 3, tool: "android", args: ["emulator", "start", "tablet"], status: 0 },
      ],
      [
        { time: 1, tool: "android", args: ["emulator", "stop", "owned"], status: 0 },
        {
          time: 2,
          tool: "adb",
          args: ["devices"],
          status: 0,
          stdout: "List of devices attached\\n",
        },
        { time: 3, tool: "android", args: ["emulator", "start", "tablet"], status: 0 },
      ],
    ];
    for (const entries of auditCases) {
      fs.writeFileSync(audit, entries.map((c) => JSON.stringify(c)).join("\n"));
      phone.serial = "emulator-5554";
      assert.equal(
        checkTask("8", {
          devices: d,
          audit,
          finalAnswer: JSON.stringify({ unavailableState: "missing", recovered: true }),
        }).success,
        false,
      );
    }
  }));

test("host emulator PID lookup requires one real executable for the exact AVD", () => {
  const processes = [
    "101 /sdk/emulator/emulator -avd phone_backup -no-window",
    "202 /sdk/qemu-system-aarch64 -avd phone -no-window",
    "303 /bin/sh -c /sdk/emulator/emulator -avd phone",
    "404 /sdk/emulator/emulator -avd tablet",
  ].join("\n");
  assert.equal(emulatorPid(processes, "phone"), "202");
  assert.throws(() => emulatorPid(processes, "other"), /Cannot identify/);
  assert.throws(() => emulatorPid(processes + "\n505 /sdk/emulator/emulator -avd phone", "phone"), /Cannot identify/);
});
test("task 8 reference confirms boot on the restarted AVD's new serial", () => {
  const phone = { name: "phone", serial: "emulator-5554" };
  let phase = "before";
  const seen = [];
  const answer = task8Reference({
    phone,
    android: (args) => {
      phase = args[1] === "stop" ? "stopped" : "restarted";
    },
    adb: (device, args) => {
      seen.push([device?.serial, ...args]);
      if (args[0] === "devices")
        return phase === "stopped"
          ? "List of devices attached\n"
          : "List of devices attached\nemulator-5580 device\n";
      if (args[0] === "emu") return "phone\nOK\n";
      return "1\n";
    },
    wait: (predicate) => assert.equal(predicate(), true),
  });
  assert.equal(answer.recovered, true);
  assert.equal(phone.serial, "emulator-5554");
  assert.ok(seen.some((call) => call[0] === "emulator-5580" && call[1] === "shell"));
});

test("bare run cannot authorize spending or reach dependency lookup", () => {
  const r = spawnSync(
    process.execPath,
    [
      path.join(root, "bench/run.js"),
      "run",
      "--tasks",
      "1",
      "--repeats",
      "1",
      "--version",
      "0.1.2",
    ],
    { env: { PATH: "" }, encoding: "utf8" },
  );
  assert.equal(r.status, 1);
  assert.doesNotMatch(r.stdout, /"run": true/);
  assert.match(r.stderr, /explicit -- flags/);
  assert.doesNotMatch(r.stderr, /command -v adb/);
});
test("a crash query mentioning the expected cause is not itself a real app crash", () => {
  const answer = JSON.stringify({
    exception: "IllegalStateException",
    message: "probe crash requested",
  });
  const devices = {
    owned: [{}],
    adb: () =>
      "123.456 10 10 I adbd: shell requested logcat | grep 'java.lang.IllegalStateException: probe crash requested'",
  };
  assert.equal(
    checkTask("3", { devices, finalAnswer: answer, audit: "/nonexistent-benchmark-audit" }).success,
    false,
  );
  devices.adb = () =>
    "123.456 100 100 E AndroidRuntime: Process: dev.probe, PID: 100\n123.457 200 200 E AndroidRuntime: java.lang.IllegalStateException: probe crash requested";
  assert.equal(
    checkTask("3", { devices, finalAnswer: answer, audit: "/nonexistent-benchmark-audit" }).success,
    false,
  );
});

test("process-death oracle rejects stale correct values after an extra increment", () => {
  const finalAnswer = JSON.stringify({
    before: { saved: 3, unsaved: 3 },
    after: { saved: 3, unsaved: 0 },
    savedSurvived: true,
    unsavedReset: true,
  });
  const devices = {
    owned: [{}],
    shell: (d, text) =>
      text.startsWith("pidof") ? "200" : "mResumedActivity dev.probe/.MainActivity",
    adb: () =>
      "123.450 100 100 I ProbeState: event=inc saved=3 volatile=3 rows=0 restored=false pid=100\n123.451 200 200 I ProbeState: event=start saved=3 volatile=0 rows=0 restored=true pid=200\n123.452 200 200 I ProbeState: event=inc saved=4 volatile=1 rows=0 restored=true pid=200",
  };
  const result = checkTask("2", { devices, finalAnswer, audit: "/nonexistent-benchmark-audit" });
  assert.equal(result.checks.processDeath, true);
  assert.equal(result.checks.currentCounters, false);
  assert.equal(result.success, false);
});
