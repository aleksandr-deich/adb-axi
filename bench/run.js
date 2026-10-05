import fs from "node:fs";
import console from "node:console";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  aggregate,
  acquireLock,
  assertConsistency,
  manifestHashes,
  readRecords,
  resumePlan,
  command,
  model,
  plan,
  root,
  skillEvidence,
  tasks,
  verifyPath,
  writeRecord,
} from "./core.js";
import { Devices } from "./devices.js";
import { runPi } from "./pi.js";
import { setupTask } from "./success.js";
const quote = (x) => `'${x.replaceAll("'", "'\\''")}'`;
function find(tool) {
  return command("/bin/sh", ["-c", `command -v ${tool}`]).trim();
}

export function environment(directory, condition, version, bins, devices, task = null) {
  fs.mkdirSync(directory, { recursive: true });
  const configDir = path.join(directory, "config");
  const skillDir = path.join(configDir, "skills");
  fs.mkdirSync(skillDir, { recursive: true });
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, `bench/conditions/${condition}.json`), "utf8"),
  );
  if (
    !Array.isArray(manifest.skills) ||
    !manifest.skills.length ||
    manifest.skills.some((s) => typeof s !== "string")
  )
    throw new Error("Manifest requires skill directories");
  for (const source of manifest.skills) {
    const from = fs.realpathSync(path.resolve(root, source));
    const relative = path.relative(root, from);
    if (relative.startsWith("..") || path.isAbsolute(relative))
      throw new Error("Skills must be repository-local");
    const destination = path.join(skillDir, path.basename(from));
    if (fs.existsSync(destination) || !fs.existsSync(path.join(from, "SKILL.md")))
      throw new Error("Duplicate or invalid skill directory");
    fs.cpSync(from, destination, { recursive: true, dereference: true });
  }
  const skills = skillEvidence(skillDir, condition);
  // Discovery is disabled; this directory is the only explicit skill source.
  fs.writeFileSync(
    path.join(configDir, "settings.json"),
    JSON.stringify({ packages: [], extensions: [], skills: [] }),
  );
  const sourceAuth = path.join(
    process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi/agent"),
    "auth.json",
  );
  if (fs.existsSync(sourceAuth)) fs.copyFileSync(sourceAuth, path.join(configDir, "auth.json"));
  const binDir = path.join(directory, "bin");
  fs.mkdirSync(binDir);
  const audit = path.join(directory, "tool-audit.jsonl");
  const toolsFile = path.join(directory, "tools.json");
  fs.writeFileSync(toolsFile, JSON.stringify({ bins, devices, condition, version, audit, task }));
  const bridge = path.join(directory, "tool-bridge.js");
  fs.copyFileSync(path.join(root, "bench/tool-bridge.js"), bridge);
  fs.writeFileSync(path.join(directory, "package.json"), '{"type":"module"}\n');
  for (const tool of ["adb", "android", ...(condition === "adb-axi" ? ["adb-axi", "npx"] : [])]) {
    fs.writeFileSync(
      path.join(binDir, tool),
      `#!/bin/sh\nexec ${quote(bins.node)} ${quote(bridge)} ${quote(tool)} "$@"\n`,
      { mode: 0o755 },
    );
  }
  fs.symlinkSync(bins.node, path.join(binDir, "node"));
  const env = {
    PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: directory,
    TMPDIR: path.join(directory, "tmp"),
    PI_CODING_AGENT_DIR: configDir,
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
    BENCH_TOOLS: toolsFile,
    ANDROID_SERIAL: devices[0].serial,
    ANDROID_HOME: process.env.ANDROID_HOME ?? path.join(os.homedir(), "Library/Android/sdk"),
    ANDROID_SDK_ROOT:
      process.env.ANDROID_SDK_ROOT ??
      process.env.ANDROID_HOME ??
      path.join(os.homedir(), "Library/Android/sdk"),
    ANDROID_AVD_HOME: process.env.ANDROID_AVD_HOME ?? path.join(os.homedir(), ".android/avd"),
    SHELL: "/bin/bash",
    BASH_ENV: "/dev/null",
    ENV: "/dev/null",
    ZDOTDIR: directory,
  };
  if (process.env.JAVA_HOME) env.JAVA_HOME = process.env.JAVA_HOME;
  for (const key of ["OPENAI_API_KEY", "OPENAI_BASE_URL"])
    if (process.env[key]) env[key] = process.env[key];
  fs.mkdirSync(env.TMPDIR);
  const pathEvidence = verifyPath(env, condition);
  return { env, skills, audit, pathEvidence, configDir };
}
async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "self-check") {
    if (argv.includes("--help")) {
      console.log(
        "node bench/run.js self-check [--tasks 1,2,3,4,5,6,7,8] [--phone <avd>] [--tablet <avd>]\nBoot owned AVDs and test reference solutions and negative outcomes. No agents or CI.",
      );
      return;
    }
    const { selfCheck } = await import("./self-check.js");
    await selfCheck(plan(argv.slice(1)));
    return;
  }
  if (argv[0] === "summary" || argv[0] === "status") {
    const allowed =
      argv[0] === "summary" ? ["--results-dir"] : ["--tasks", "--repeats", "--results-dir"];
    for (let i = 1; i < argv.length; i += 2)
      if (!allowed.includes(argv[i]) || !argv[i + 1])
        throw new Error(`Invalid ${argv[0]} option: ${argv[i]}`);
    if (argv[0] === "status" && (!argv.includes("--tasks") || !argv.includes("--repeats")))
      throw new Error("status requires --tasks and --repeats");
    const options = plan(argv.slice(1));
    const records = readRecords(options.resultsDir);
    const progress = resumePlan(options, records, false);
    console.log(
      JSON.stringify(
        argv[0] === "summary"
          ? aggregate(records)
          : { groups: progress.groups, totalRemaining: progress.totalRemaining },
        null,
        2,
      ),
    );
    return;
  }
  const options = plan(argv);
  const results = options.resultsDir;
  const records = readRecords(results);
  const progress = resumePlan(options, records);
  console.log(
    JSON.stringify(
      {
        ...options,
        ...progress,
        model,
        effort: "medium",
        setup:
          "Boot owned phone and tablet, reset both before and after each sequential run, shutdown afterwards",
        taskDefinitions: tasks().filter((t) => options.tasks.includes(t.id)),
      },
      null,
      2,
    ),
  );
  if (!options.run) return;
  const agentVersion = command(find("pi"), ["--version"]).trim();
  const benchmarkRevision = command("git", ["rev-parse", "HEAD"], { cwd: root }).trim();
  const identity = {
    model,
    effort: "medium",
    agentVersion,
    benchmarkRevision,
    adbAxiVersion: options.version,
    skillManifestHashes: manifestHashes(),
  };
  assertConsistency(records, identity);
  fs.mkdirSync(results, { recursive: true });
  const lock = path.join(os.tmpdir(), "android-repeatable-benchmark.lock");
  if (!progress.toRun.length && !fs.existsSync(lock)) return;
  // A single host-wide lock prevents concurrent benchmark processes sharing AVDs.
  const bins = Object.fromEntries(["adb", "android", "pi", "node", "npx"].map((t) => [t, find(t)]));
  const ownership = acquireLock(lock, [options.phone, options.tablet]);
  const devices = new Devices(bins, [options.phone, options.tablet]);
  devices.androidLayout = (d) => command(bins.android, ["layout", `--device=${d.serial}`]);
  const work = progress.toRun.length
    ? fs.mkdtempSync(path.join(os.tmpdir(), "android-benchmark-"))
    : null;
  try {
    devices.boot(ownership.previous, !!progress.toRun.length, ownership.save);
    if (!progress.toRun.length) return;
    const benchmarkDirty = !!command("git", ["status", "--porcelain"], { cwd: root }).trim();
    const toolVersions = {
      android: command(bins.android, ["-V"]).trim(),
      adb: command(bins.adb, ["version"]).trim(),
    };
    for (const run of progress.toRun) {
      const task = tasks().find((t) => t.id === run.task);
      const { repeat, condition } = run;
      const id = `${Date.now()}-${task.id}-${condition}-${repeat}-${crypto.randomUUID()}`;
      const directory = path.join(work, id);
      const record = {
        id,
        task: task.id,
        condition,
        repeat,
        adbAxiVersion: options.version,
        agent: "pi",
        agentVersion,
        benchmarkRevision,
        benchmarkDirty,
        taskDefinitionSha256: crypto
          .createHash("sha256")
          .update(JSON.stringify(task))
          .digest("hex"),
        toolVersions,
        model,
        effort: "medium",
        skillManifestHashes: identity.skillManifestHashes,
        success: null,
        verdictProduced: false,
        inputTokens: null,
        cost: null,
        turns: null,
        wallTimeMs: null,
        devices: devices.owned.map((d) => ({ name: d.name, serial: d.serial })),
        startedAt: new Date().toISOString(),
      };
      try {
        setupTask(task, devices);
        const controlled = environment(
          directory,
          condition,
          options.version,
          bins,
          record.devices,
          task.id,
        );
        record.skills = controlled.skills;
        record.pathEvidence = controlled.pathEvidence;
        record.isolation = {
          configDir: controlled.configDir,
          noDiscovery: ["extensions", "skills", "context-files", "prompt-templates", "themes"],
          skillSource: "isolated config plus explicit --skill paths",
        };
        for (const variant of ["debug", "release"])
          fs.copyFileSync(
            path.join(root, `test/fixtures/apk/probe-${variant}.apk`),
            path.join(directory, `probe-${variant}.apk`),
          );
        const prompt = `Work only on the following benchmark-owned emulators: phone ${devices.owned[0].serial} (AVD ${options.phone}), tablet ${devices.owned[1].serial} (AVD ${options.tablet}). Never touch other emulators or physical devices, or restart the shared device server. The debug and release APKs are ./probe-debug.apk and ./probe-release.apk; package dev.probe. The UI action is the device shell activity launch: am start -n dev.probe/.MainActivity --es probe <inc|write|crash|anr>. Do not install additional tools or skills or change PATH. Always use an explicit serial for device operations.\n\n${task.prompt}`;
        const started = Date.now();
        try {
          Object.assign(
            record,
            runPi({
              binary: bins.pi,
              env: controlled.env,
              cwd: directory,
              skills: controlled.skills,
              prompt,
              output: path.join(directory, "agent.jsonl"),
            }),
          );
        } finally {
          record.wallTimeMs = Date.now() - started;
        }
        const check = (await import(pathToFileURL(path.join(root, task.success)).href)).default;
        Object.assign(
          record,
          check({ devices, finalAnswer: record.finalAnswer, audit: controlled.audit }),
        );
        record.verdictProduced = typeof record.success === "boolean";
        if (record.agentError) record.success = false;
      } catch (e) {
        if (e.metrics) Object.assign(record, e.metrics);
        record.error = String(e);
      } finally {
        fs.mkdirSync(results, { recursive: true });
        for (const [source, field, suffix] of [
          ["agent.jsonl", "agentOutput", "agent.jsonl"],
          ["tool-audit.jsonl", "audit", "audit.jsonl"],
          ["pi-invocation.json", "invocation", "invocation.json"],
        ]) {
          if (fs.existsSync(path.join(directory, source))) {
            record[field] = path.join(results, `${id}.${suffix}`);
            fs.copyFileSync(path.join(directory, source), record[field]);
          }
        }
        try {
          devices.reset();
          record.reset = "verified";
        } catch (e) {
          record.reset = String(e);
          record.success = false;
        }
        writeRecord(results, record);
      }
      console.log(JSON.stringify(record));
      if (record.reset !== "verified" || !record.pathEvidence)
        throw new Error("Safety/reset failure; remaining runs cancelled");
    }
  } finally {
    try {
      devices.shutdown();
      fs.rmSync(lock, { recursive: true });
    } finally {
      if (work) fs.rmSync(work, { recursive: true, force: true });
    }
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename)
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
